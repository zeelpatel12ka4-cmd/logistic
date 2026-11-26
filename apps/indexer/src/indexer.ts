import { ethers } from 'ethers';
import { Pool, PoolClient } from 'pg';
import { CHAIN_TRACE_REGISTRY_ABI, CustodyStatus, RpcFailoverPool } from '@chaintrace/shared';

export interface IndexerConfig {
  chainId: number;
  contractAddress: string;
  confirmationsRequired: number;
  initialChunkSize: number;
  startBlock?: number;
}

export interface SyncReport {
  fromBlock: number;
  toBlock: number;
  eventsProcessed: number;
  failedTxsDetected: number;
  reorgDetected: boolean;
  commonAncestorBlock?: number;
}

const iface = new ethers.Interface(CHAIN_TRACE_REGISTRY_ABI);

export class ReorgSafeIndexer {
  private chunkSize: number;

  constructor(
    private readonly pool: Pool,
    private readonly rpcPool: RpcFailoverPool,
    private readonly config: IndexerConfig,
  ) {
    this.chunkSize = Math.max(100, config.initialChunkSize);
  }

  public async syncOnce(): Promise<SyncReport> {
    const contractAddr = ethers.getAddress(this.config.contractAddress);
    const latestBlockNum = await this.rpcPool.execute((p) => p.getBlockNumber());

    const checkpointRes = await this.pool.query<{
      last_indexed_block: string;
      last_indexed_hash: string;
    }>(
      `SELECT last_indexed_block, last_indexed_hash
       FROM indexer_checkpoints
       WHERE chain_id = $1 AND contract_address = $2`,
      [this.config.chainId, contractAddr],
    );

    let lastIndexedBlock =
      checkpointRes.rowCount && checkpointRes.rows[0]
        ? Number(checkpointRes.rows[0].last_indexed_block)
        : (this.config.startBlock ?? 0) - 1;

    let reorgDetected = false;
    let commonAncestorBlock: number | undefined;

    // Step 1: Verify canonical chain continuity & handle reorgs / chain rollbacks
    if (lastIndexedBlock >= 0) {
      const checkFrom = Math.min(lastIndexedBlock, latestBlockNum);
      const ancestor = await this.findCommonAncestor(checkFrom);
      if (ancestor < lastIndexedBlock) {
        reorgDetected = true;
        commonAncestorBlock = ancestor;
        await this.rollbackToAncestor(contractAddr, lastIndexedBlock, ancestor);
        lastIndexedBlock = ancestor;
      }
    }

    const fromBlock = Math.max(0, lastIndexedBlock + 1);
    if (fromBlock > latestBlockNum) {
      await this.markFinalizedBlocks(latestBlockNum);
      return {
        fromBlock,
        toBlock: latestBlockNum,
        eventsProcessed: 0,
        failedTxsDetected: 0,
        reorgDetected,
        commonAncestorBlock,
      };
    }

    // Step 2: Adaptive chunked backfill
    let cursor = fromBlock;
    let totalEvents = 0;
    let totalFailedTxs = 0;

    while (cursor <= latestBlockNum) {
      const endBlock = Math.min(cursor + this.chunkSize - 1, latestBlockNum);
      try {
        const chunkResult = await this.processChunk(contractAddr, cursor, endBlock, latestBlockNum);
        totalEvents += chunkResult.eventsProcessed;
        totalFailedTxs += chunkResult.failedTxsDetected;
        cursor = endBlock + 1;
      } catch (err) {
        if (this.isLogRangeError(err) && this.chunkSize > 100) {
          this.chunkSize = Math.max(100, Math.floor(this.chunkSize / 2));
          continue;
        }
        throw err;
      }
    }

    await this.markFinalizedBlocks(latestBlockNum);

    return {
      fromBlock,
      toBlock: latestBlockNum,
      eventsProcessed: totalEvents,
      failedTxsDetected: totalFailedTxs,
      reorgDetected,
      commonAncestorBlock,
    };
  }

  private async findCommonAncestor(startHeight: number): Promise<number> {
    let cursor = startHeight;
    while (cursor >= 0) {
      const stored = await this.pool.query<{ block_hash: string; is_finalized: boolean }>(
        `SELECT block_hash, is_finalized FROM indexed_blocks
         WHERE chain_id = $1 AND block_number = $2`,
        [this.config.chainId, cursor],
      );
      if (!stored.rowCount) {
        cursor -= 1;
        continue;
      }
      const chainBlock = await this.rpcPool.execute((p) => p.getBlock(cursor));
      if (chainBlock && chainBlock.hash?.toLowerCase() === stored.rows[0].block_hash.toLowerCase()) {
        return cursor;
      }
      cursor -= 1;
    }
    return -1;
  }

  private async rollbackToAncestor(
    contractAddr: string,
    previousTip: number,
    ancestor: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const orphanedBlocksRes = await client.query<{ block_hash: string }>(
        `SELECT block_hash FROM indexed_blocks
         WHERE chain_id = $1 AND block_number > $2 ORDER BY block_number ASC`,
        [this.config.chainId, ancestor],
      );
      const orphanedHashes = orphanedBlocksRes.rows.map((r) => r.block_hash);

      const affectedEventsRes = await client.query<{
        batch_id: string | null;
        product_id: string | null;
      }>(
        `UPDATE product_events
         SET is_reorged = TRUE
         WHERE chain_id = $1 AND block_number > $2 AND is_reorged = FALSE
         RETURNING batch_id, product_id`,
        [this.config.chainId, ancestor],
      );

      await client.query(
        `UPDATE failed_transactions
         SET is_reorged = TRUE
         WHERE chain_id = $1 AND block_number > $2 AND is_reorged = FALSE`,
        [this.config.chainId, ancestor],
      );

      await client.query(
        `DELETE FROM indexed_blocks WHERE chain_id = $1 AND block_number > $2`,
        [this.config.chainId, ancestor],
      );

      await client.query(
        `INSERT INTO reorg_events (
           chain_id, detected_at_block, common_ancestor_block, orphaned_block_hashes, rolled_back_event_count
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          this.config.chainId,
          previousTip,
          ancestor,
          orphanedHashes,
          affectedEventsRes.rowCount ?? 0,
        ],
      );

      // Delete batches registered only in orphaned blocks
      await client.query(
        `DELETE FROM batches WHERE chain_id = $1 AND block_number > $2`,
        [this.config.chainId, ancestor],
      );

      // Recompute state of remaining affected batches & products strictly from canonical events <= ancestor
      const affectedBatches = new Set<string>();
      const affectedProducts = new Set<string>();
      for (const row of affectedEventsRes.rows) {
        if (row.batch_id) affectedBatches.add(row.batch_id);
        if (row.product_id) affectedProducts.add(row.product_id);
      }

      for (const batchId of affectedBatches) {
        await this.recomputeBatchFromCanonicalEvents(client, batchId, ancestor);
      }
      for (const productId of affectedProducts) {
        await this.recomputeProductFromCanonicalEvents(client, productId, ancestor);
      }

      const ancestorRow = await client.query<{ block_hash: string }>(
        `SELECT block_hash FROM indexed_blocks WHERE chain_id = $1 AND block_number = $2`,
        [this.config.chainId, ancestor],
      );
      const ancestorHash = ancestorRow.rows[0]?.block_hash ?? ethers.ZeroHash;

      await client.query(
        `INSERT INTO indexer_checkpoints (chain_id, contract_address, last_indexed_block, last_indexed_hash, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (chain_id, contract_address)
         DO UPDATE SET last_indexed_block = EXCLUDED.last_indexed_block,
                       last_indexed_hash = EXCLUDED.last_indexed_hash,
                       updated_at = NOW()`,
        [this.config.chainId, contractAddr, ancestor, ancestorHash],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async processChunk(
    contractAddr: string,
    fromBlock: number,
    toBlock: number,
    latestChainTip: number,
  ): Promise<{ eventsProcessed: number; failedTxsDetected: number }> {
    const logs = await this.rpcPool.execute((p) =>
      p.getLogs({
        address: contractAddr,
        fromBlock,
        toBlock,
      }),
    );

    // Fetch blocks in chunk to record parent hashes & detect reverted transactions targeting our contract
    const blockNumbersToFetch = new Set<number>();
    for (const log of logs) blockNumbersToFetch.add(log.blockNumber);
    // Always include chunk boundary & recent blocks for reorg chain continuity
    if (toBlock - fromBlock <= 32) {
      for (let b = fromBlock; b <= toBlock; b++) blockNumbersToFetch.add(b);
    } else {
      blockNumbersToFetch.add(toBlock);
    }

    const fetchedBlocks = new Map<number, ethers.Block>();
    for (const bNum of blockNumbersToFetch) {
      const blk = await this.rpcPool.execute((p) => p.getBlock(bNum, true));
      if (blk) fetchedBlocks.set(bNum, blk);
    }

    // Check reverted transactions targeting our contract within fetched blocks
    const failedTxs: Array<{
      txHash: string;
      blockNumber: number;
      blockHash: string;
      from: string;
      to: string;
      methodName: string | null;
      decodedError: string | null;
      rawRevertData: string | null;
      productId: string | null;
      batchId: string | null;
      timestamp: number;
    }> = [];

    for (const blk of fetchedBlocks.values()) {
      for (const txOrHash of blk.prefetchedTransactions ?? []) {
        if (!txOrHash.to || ethers.getAddress(txOrHash.to) !== contractAddr) continue;
        const receipt = await this.rpcPool.execute((p) => p.getTransactionReceipt(txOrHash.hash));
        if (receipt && receipt.status === 0) {
          const decodedTx = this.tryParseTxInput(txOrHash.data);
          const revertInfo = await this.tryDecodeRevert(txOrHash, blk.number);
          failedTxs.push({
            txHash: txOrHash.hash,
            blockNumber: blk.number,
            blockHash: blk.hash || ethers.ZeroHash,
            from: ethers.getAddress(txOrHash.from),
            to: contractAddr,
            methodName: decodedTx.methodName,
            decodedError: revertInfo.decodedError,
            rawRevertData: revertInfo.rawData,
            productId: decodedTx.productId,
            batchId: decodedTx.batchId,
            timestamp: blk.timestamp,
          });
        }
      }
    }

    const client = await this.pool.connect();
    let insertedEvents = 0;

    try {
      await client.query('BEGIN');

      for (const blk of fetchedBlocks.values()) {
        const finalized = blk.number <= latestChainTip - this.config.confirmationsRequired;
        await client.query(
          `INSERT INTO indexed_blocks (chain_id, block_number, block_hash, parent_hash, timestamp_sec, is_finalized)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (chain_id, block_number)
           DO UPDATE SET block_hash = EXCLUDED.block_hash,
                         parent_hash = EXCLUDED.parent_hash,
                         timestamp_sec = EXCLUDED.timestamp_sec,
                         is_finalized = EXCLUDED.is_finalized`,
          [
            this.config.chainId,
            blk.number,
            blk.hash || ethers.ZeroHash,
            blk.parentHash,
            blk.timestamp,
            finalized,
          ],
        );
      }

      for (const ftx of failedTxs) {
        await client.query(
          `INSERT INTO failed_transactions (
             tx_hash, chain_id, block_number, block_hash, from_address, to_address,
             method_name, decoded_error, raw_revert_data, product_id, batch_id, block_timestamp, is_reorged
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE)
           ON CONFLICT (tx_hash) DO UPDATE SET is_reorged = FALSE, block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`,
          [
            ftx.txHash,
            this.config.chainId,
            ftx.blockNumber,
            ftx.blockHash,
            ftx.from,
            ftx.to,
            ftx.methodName,
            ftx.decodedError,
            ftx.rawRevertData,
            ftx.productId,
            ftx.batchId,
            ftx.timestamp,
          ],
        );
      }

      for (const log of logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        const blk = fetchedBlocks.get(log.blockNumber);
        const blockTs = blk?.timestamp ?? Math.floor(Date.now() / 1000);
        const finalized = log.blockNumber <= latestChainTip - this.config.confirmationsRequired;

        const mapped = this.extractEventProjection(parsed, log, blockTs);
        const insertRes = await client.query(
          `INSERT INTO product_events (
             chain_id, block_number, block_hash, tx_hash, log_index, event_name,
             batch_id, product_id, from_address, to_address, status_code, nonce,
             payload, block_timestamp, is_reorged, is_finalized
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE,$15)
           ON CONFLICT (chain_id, block_hash, tx_hash, log_index) DO NOTHING`,
          [
            this.config.chainId,
            log.blockNumber,
            log.blockHash,
            log.transactionHash,
            log.index,
            parsed.name,
            mapped.batchId,
            mapped.productId,
            mapped.fromAddress,
            mapped.toAddress,
            mapped.statusCode,
            mapped.nonce,
            JSON.stringify(mapped.payload),
            blockTs,
            finalized,
          ],
        );

        if ((insertRes.rowCount ?? 0) > 0) {
          insertedEvents += 1;
        }
        await this.applyEventToProjections(client, parsed.name, mapped, log.transactionHash, log.blockNumber, finalized);
      }

      const tipBlock = fetchedBlocks.get(toBlock);
      const tipHash = tipBlock?.hash ?? ethers.ZeroHash;
      await client.query(
        `INSERT INTO indexer_checkpoints (chain_id, contract_address, last_indexed_block, last_indexed_hash, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (chain_id, contract_address)
         DO UPDATE SET last_indexed_block = EXCLUDED.last_indexed_block,
                       last_indexed_hash = EXCLUDED.last_indexed_hash,
                       updated_at = NOW()`,
        [this.config.chainId, contractAddr, toBlock, tipHash],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { eventsProcessed: insertedEvents, failedTxsDetected: failedTxs.length };
  }

  private extractEventProjection(
    parsed: ethers.LogDescription,
    log: ethers.Log,
    blockTs: number,
  ): {
    batchId: string | null;
    productId: string | null;
    fromAddress: string | null;
    toAddress: string | null;
    statusCode: number | null;
    nonce: number | null;
    payload: Record<string, unknown>;
  } {
    const args = parsed.args;
    const basePayload: Record<string, unknown> = {
      eventName: parsed.name,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.index,
      timestamp: blockTs,
    };

    switch (parsed.name) {
      case 'BatchRegistered':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.manufacturer,
          toAddress: args.manufacturer,
          statusCode: CustodyStatus.Manufactured,
          nonce: 0,
          payload: {
            ...basePayload,
            merkleRoot: args.merkleRoot,
            ipfsCid: args.ipfsCid,
            unitCount: Number(args.unitCount),
            manufacturer: args.manufacturer,
          },
        };
      case 'BatchTransferInitiated':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.from,
          toAddress: args.to,
          statusCode: CustodyStatus.InTransit,
          nonce: Number(args.batchNonce),
          payload: {
            ...basePayload,
            from: args.from,
            to: args.to,
            targetStatus: Number(args.targetStatus),
            shipmentRef: args.shipmentRef,
            batchNonce: Number(args.batchNonce),
          },
        };
      case 'BatchCustodyAccepted':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.previousCustodian,
          toAddress: args.newCustodian,
          statusCode: Number(args.newStatus),
          nonce: Number(args.batchNonce),
          payload: {
            ...basePayload,
            previousCustodian: args.previousCustodian,
            newCustodian: args.newCustodian,
            newStatus: Number(args.newStatus),
            batchNonce: Number(args.batchNonce),
          },
        };
      case 'BatchTransferCancelled':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.custodian,
          toAddress: args.custodian,
          statusCode: null,
          nonce: Number(args.batchNonce),
          payload: { ...basePayload, custodian: args.custodian, batchNonce: Number(args.batchNonce) },
        };
      case 'BatchStatusUpdated':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.custodian,
          toAddress: args.custodian,
          statusCode: Number(args.newStatus),
          nonce: null,
          payload: {
            ...basePayload,
            custodian: args.custodian,
            newStatus: Number(args.newStatus),
            locationNote: args.locationNote,
          },
        };
      case 'ProductMaterialized':
        return {
          batchId: args.batchId,
          productId: args.productId,
          fromAddress: args.custodian,
          toAddress: args.custodian,
          statusCode: null,
          nonce: 0,
          payload: {
            ...basePayload,
            custodian: args.custodian,
            metadataHash: args.metadataHash,
          },
        };
      case 'TransferInitiated':
        return {
          batchId: args.batchId,
          productId: args.productId,
          fromAddress: args.from,
          toAddress: args.to,
          statusCode: CustodyStatus.InTransit,
          nonce: Number(args.nonce),
          payload: {
            ...basePayload,
            from: args.from,
            to: args.to,
            targetStatus: Number(args.targetStatus),
            shipmentRef: args.shipmentRef,
            nonce: Number(args.nonce),
          },
        };
      case 'CustodyAccepted':
        return {
          batchId: args.batchId,
          productId: args.productId,
          fromAddress: args.previousCustodian,
          toAddress: args.newCustodian,
          statusCode: Number(args.newStatus),
          nonce: Number(args.nonce),
          payload: {
            ...basePayload,
            previousCustodian: args.previousCustodian,
            newCustodian: args.newCustodian,
            newStatus: Number(args.newStatus),
            locationNote: args.locationNote,
            nonce: Number(args.nonce),
          },
        };
      case 'TransferCancelled':
        return {
          batchId: null,
          productId: args.productId,
          fromAddress: args.custodian,
          toAddress: args.custodian,
          statusCode: null,
          nonce: Number(args.nonce),
          payload: { ...basePayload, custodian: args.custodian, nonce: Number(args.nonce) },
        };
      case 'DeliveryStatusUpdated':
        return {
          batchId: null,
          productId: args.productId,
          fromAddress: args.custodian,
          toAddress: args.custodian,
          statusCode: Number(args.newStatus),
          nonce: null,
          payload: {
            ...basePayload,
            custodian: args.custodian,
            newStatus: Number(args.newStatus),
            locationNote: args.locationNote,
          },
        };
      case 'ProductClaimed':
        return {
          batchId: args.batchId,
          productId: args.productId,
          fromAddress: null,
          toAddress: args.claimant,
          statusCode: CustodyStatus.Claimed,
          nonce: Number(args.nonce),
          payload: {
            ...basePayload,
            claimant: args.claimant,
            nonce: Number(args.nonce),
          },
        };
      case 'BatchRecalled':
        return {
          batchId: args.batchId,
          productId: null,
          fromAddress: args.actor,
          toAddress: null,
          statusCode: CustodyStatus.Recalled,
          nonce: null,
          payload: { ...basePayload, actor: args.actor, reason: args.reason },
        };
      case 'ProductFlagged':
        return {
          batchId: null,
          productId: args.productId,
          fromAddress: args.actor,
          toAddress: null,
          statusCode: CustodyStatus.Recalled,
          nonce: null,
          payload: { ...basePayload, actor: args.actor, reason: args.reason },
        };
      default:
        return {
          batchId: null,
          productId: null,
          fromAddress: null,
          toAddress: null,
          statusCode: null,
          nonce: null,
          payload: basePayload,
        };
    }
  }

  private async applyEventToProjections(
    client: PoolClient,
    eventName: string,
    mapped: ReturnType<ReorgSafeIndexer['extractEventProjection']>,
    txHash: string,
    blockNumber: number,
    finalized: boolean,
  ): Promise<void> {
    const p = mapped.payload;
    switch (eventName) {
      case 'BatchRegistered':
        await client.query(
          `INSERT INTO batches (
             batch_id, chain_id, manufacturer_address, batch_custodian, merkle_root,
             ipfs_cid, unit_count, batch_status, previous_batch_status, onchain_confirmed, tx_hash, block_number, is_finalized
           ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$7,TRUE,$8,$9,$10)
           ON CONFLICT (batch_id)
           DO UPDATE SET merkle_root = EXCLUDED.merkle_root,
                         ipfs_cid = EXCLUDED.ipfs_cid,
                         onchain_confirmed = TRUE,
                         tx_hash = EXCLUDED.tx_hash,
                         block_number = EXCLUDED.block_number,
                         is_finalized = EXCLUDED.is_finalized,
                         updated_at = NOW()`,
          [
            mapped.batchId,
            this.config.chainId,
            mapped.fromAddress,
            p.merkleRoot,
            p.ipfsCid,
            p.unitCount,
            CustodyStatus.Manufactured,
            txHash,
            blockNumber,
            finalized,
          ],
        );
        break;

      case 'BatchTransferInitiated':
        await client.query(
          `UPDATE batches
           SET previous_batch_status = batch_status,
               pending_batch_custodian = $2,
               batch_status = $3,
               batch_nonce = $4,
               tx_hash = $5,
               block_number = $6,
               updated_at = NOW()
           WHERE batch_id = $1`,
          [mapped.batchId, mapped.toAddress, CustodyStatus.InTransit, mapped.nonce, txHash, blockNumber],
        );
        // Propagate batch custody change to unsplit products in the batch
        await client.query(
          `UPDATE products
           SET custody_status = $2,
               pending_custodian = $3,
               updated_at = NOW()
           WHERE batch_id = $1 AND is_materialized = FALSE`,
          [mapped.batchId, CustodyStatus.InTransit, mapped.toAddress],
        );
        break;

      case 'BatchCustodyAccepted':
        await client.query(
          `UPDATE batches
           SET batch_custodian = $2,
               pending_batch_custodian = NULL,
               batch_status = $3,
               previous_batch_status = $3,
               batch_nonce = $4,
               tx_hash = $5,
               block_number = $6,
               updated_at = NOW()
           WHERE batch_id = $1`,
          [mapped.batchId, mapped.toAddress, mapped.statusCode, mapped.nonce, txHash, blockNumber],
        );
        await client.query(
          `UPDATE products
           SET current_custodian = $2,
               pending_custodian = NULL,
               custody_status = $3,
               previous_status = $3,
               updated_at = NOW()
           WHERE batch_id = $1 AND is_materialized = FALSE`,
          [mapped.batchId, mapped.toAddress, mapped.statusCode],
        );
        break;

      case 'BatchTransferCancelled':
        await client.query(
          `UPDATE batches
           SET pending_batch_custodian = NULL,
               batch_status = previous_batch_status,
               batch_nonce = $2,
               updated_at = NOW()
           WHERE batch_id = $1`,
          [mapped.batchId, mapped.nonce],
        );
        await client.query(
          `UPDATE products p
           SET pending_custodian = NULL,
               custody_status = b.batch_status,
               updated_at = NOW()
           FROM batches b
           WHERE p.batch_id = b.batch_id AND p.batch_id = $1 AND p.is_materialized = FALSE`,
          [mapped.batchId],
        );
        break;

      case 'BatchStatusUpdated':
        await client.query(
          `UPDATE batches
           SET batch_status = $2,
               previous_batch_status = $2,
               updated_at = NOW()
           WHERE batch_id = $1`,
          [mapped.batchId, mapped.statusCode],
        );
        await client.query(
          `UPDATE products
           SET custody_status = $2,
               previous_status = $2,
               updated_at = NOW()
           WHERE batch_id = $1 AND is_materialized = FALSE`,
          [mapped.batchId, mapped.statusCode],
        );
        break;

      case 'ProductMaterialized':
        await client.query(
          `INSERT INTO products (
             product_id, batch_id, serial_number, leaf_index, metadata_hash, claim_secret_hash,
             is_materialized, current_custodian, custody_status, previous_status, nonce, last_tx_hash, last_block_number
           )
           SELECT $1::varchar, $2::varchar, COALESCE((SELECT serial_number FROM products WHERE product_id = $1::varchar), 'ONCHAIN'),
                  COALESCE((SELECT leaf_index FROM products WHERE product_id = $1::varchar), 0),
                  $3::varchar,
                  COALESCE((SELECT claim_secret_hash FROM products WHERE product_id = $1::varchar), $4::varchar),
                  TRUE, $5::varchar, b.batch_status, b.batch_status, 0, $6::varchar, $7::bigint
           FROM batches b WHERE b.batch_id = $2::varchar
           ON CONFLICT (product_id)
           DO UPDATE SET is_materialized = TRUE,
                         current_custodian = EXCLUDED.current_custodian,
                         last_tx_hash = EXCLUDED.last_tx_hash,
                         last_block_number = EXCLUDED.last_block_number,
                         updated_at = NOW()`,
          [
            mapped.productId,
            mapped.batchId,
            p.metadataHash,
            ethers.ZeroHash,
            mapped.fromAddress,
            txHash,
            blockNumber,
          ],
        );
        await client.query(
          `UPDATE batches SET split_count = split_count + 1, updated_at = NOW() WHERE batch_id = $1`,
          [mapped.batchId],
        );
        break;

      case 'TransferInitiated':
        await client.query(
          `UPDATE products
           SET previous_status = custody_status,
               pending_custodian = $2,
               custody_status = $3,
               nonce = $4,
               last_tx_hash = $5,
               last_block_number = $6,
               updated_at = NOW()
           WHERE product_id = $1`,
          [mapped.productId, mapped.toAddress, CustodyStatus.InTransit, mapped.nonce, txHash, blockNumber],
        );
        break;

      case 'CustodyAccepted':
        await client.query(
          `UPDATE products
           SET current_custodian = $2,
               pending_custodian = NULL,
               custody_status = $3,
               previous_status = $3,
               nonce = $4,
               last_tx_hash = $5,
               last_block_number = $6,
               updated_at = NOW()
           WHERE product_id = $1`,
          [mapped.productId, mapped.toAddress, mapped.statusCode, mapped.nonce, txHash, blockNumber],
        );
        break;

      case 'TransferCancelled':
        await client.query(
          `UPDATE products
           SET pending_custodian = NULL,
               custody_status = previous_status,
               nonce = $2,
               last_tx_hash = $3,
               last_block_number = $4,
               updated_at = NOW()
           WHERE product_id = $1`,
          [mapped.productId, mapped.nonce, txHash, blockNumber],
        );
        break;

      case 'DeliveryStatusUpdated':
        await client.query(
          `UPDATE products
           SET custody_status = $2,
               previous_status = $2,
               last_tx_hash = $3,
               last_block_number = $4,
               updated_at = NOW()
           WHERE product_id = $1`,
          [mapped.productId, mapped.statusCode, txHash, blockNumber],
        );
        break;

      case 'ProductClaimed':
        await client.query(
          `UPDATE products
           SET claimed = TRUE,
               current_custodian = $2,
               pending_custodian = NULL,
               custody_status = $3,
               nonce = $4,
               last_tx_hash = $5,
               last_block_number = $6,
               updated_at = NOW()
           WHERE product_id = $1`,
          [mapped.productId, mapped.toAddress, CustodyStatus.Claimed, mapped.nonce, txHash, blockNumber],
        );
        await client.query(
          `UPDATE product_secrets
           SET claim_secret = NULL,
               encrypted_claim_secret = NULL,
               retired_at = NOW(),
               retired_reason = 'CLAIMED_ON_CHAIN'
           WHERE product_id = $1 AND retired_at IS NULL`,
          [mapped.productId],
        );
        break;

      case 'BatchRecalled':
        await client.query(
          `UPDATE batches SET recalled = TRUE, batch_status = $2, updated_at = NOW() WHERE batch_id = $1`,
          [mapped.batchId, CustodyStatus.Recalled],
        );
        await client.query(
          `UPDATE products SET recalled = TRUE, custody_status = $2, updated_at = NOW() WHERE batch_id = $1`,
          [mapped.batchId, CustodyStatus.Recalled],
        );
        break;

      case 'ProductFlagged':
        await client.query(
          `UPDATE products SET recalled = TRUE, custody_status = $2, updated_at = NOW() WHERE product_id = $1`,
          [mapped.productId, CustodyStatus.Recalled],
        );
        break;
    }
  }

  private async recomputeBatchFromCanonicalEvents(
    client: PoolClient,
    batchId: string,
    maxBlock: number,
  ): Promise<void> {
    const events = await client.query<{
      event_name: string;
      batch_id: string | null;
      product_id: string | null;
      from_address: string | null;
      to_address: string | null;
      status_code: number | null;
      nonce: string | null;
      payload: Record<string, unknown>;
      tx_hash: string;
      block_number: string;
      is_finalized: boolean;
    }>(
      `SELECT event_name, batch_id, product_id, from_address, to_address, status_code, nonce, payload, tx_hash, block_number, is_finalized
       FROM product_events
       WHERE batch_id = $1 AND product_id IS NULL AND is_reorged = FALSE AND block_number <= $2
       ORDER BY block_number ASC, log_index ASC`,
      [batchId, maxBlock],
    );

    await client.query(`UPDATE batches SET split_count = 0, recalled = FALSE WHERE batch_id = $1`, [batchId]);
    for (const row of events.rows) {
      await this.applyEventToProjections(
        client,
        row.event_name,
        {
          batchId: row.batch_id,
          productId: row.product_id,
          fromAddress: row.from_address,
          toAddress: row.to_address,
          statusCode: row.status_code,
          nonce: row.nonce !== null ? Number(row.nonce) : null,
          payload: row.payload,
        },
        row.tx_hash,
        Number(row.block_number),
        row.is_finalized,
      );
    }
  }

  private async recomputeProductFromCanonicalEvents(
    client: PoolClient,
    productId: string,
    maxBlock: number,
  ): Promise<void> {
    const prodRes = await client.query<{ batch_id: string }>(`SELECT batch_id FROM products WHERE product_id = $1`, [
      productId,
    ]);
    if (!prodRes.rowCount) return;
    const batchId = prodRes.rows[0].batch_id;

    // Reset product to batch state first
    await client.query(
      `UPDATE products p
       SET is_materialized = FALSE,
           current_custodian = b.batch_custodian,
           pending_custodian = b.pending_batch_custodian,
           custody_status = b.batch_status,
           previous_status = b.previous_batch_status,
           nonce = 0,
           claimed = FALSE,
           recalled = b.recalled,
           updated_at = NOW()
       FROM batches b
       WHERE p.product_id = $1 AND p.batch_id = b.batch_id`,
      [productId],
    );

    const events = await client.query<{
      event_name: string;
      batch_id: string | null;
      product_id: string | null;
      from_address: string | null;
      to_address: string | null;
      status_code: number | null;
      nonce: string | null;
      payload: Record<string, unknown>;
      tx_hash: string;
      block_number: string;
      is_finalized: boolean;
    }>(
      `SELECT event_name, batch_id, product_id, from_address, to_address, status_code, nonce, payload, tx_hash, block_number, is_finalized
       FROM product_events
       WHERE product_id = $1 AND is_reorged = FALSE AND block_number <= $2
       ORDER BY block_number ASC, log_index ASC`,
      [productId, maxBlock],
    );

    for (const row of events.rows) {
      await this.applyEventToProjections(
        client,
        row.event_name,
        {
          batchId: row.batch_id ?? batchId,
          productId: row.product_id,
          fromAddress: row.from_address,
          toAddress: row.to_address,
          statusCode: row.status_code,
          nonce: row.nonce !== null ? Number(row.nonce) : null,
          payload: row.payload,
        },
        row.tx_hash,
        Number(row.block_number),
        row.is_finalized,
      );
    }
  }

  private async markFinalizedBlocks(latestChainTip: number): Promise<void> {
    const finalizedUpTo = latestChainTip - this.config.confirmationsRequired;
    if (finalizedUpTo < 0) return;

    await this.pool.query(
      `UPDATE indexed_blocks SET is_finalized = TRUE WHERE chain_id = $1 AND block_number <= $2 AND is_finalized = FALSE`,
      [this.config.chainId, finalizedUpTo],
    );
    await this.pool.query(
      `UPDATE product_events SET is_finalized = TRUE WHERE chain_id = $1 AND block_number <= $2 AND is_finalized = FALSE AND is_reorged = FALSE`,
      [this.config.chainId, finalizedUpTo],
    );
    await this.pool.query(
      `UPDATE batches SET is_finalized = TRUE WHERE chain_id = $1 AND block_number <= $2 AND is_finalized = FALSE`,
      [this.config.chainId, finalizedUpTo],
    );
  }

  private tryParseTxInput(data: string): {
    methodName: string | null;
    productId: string | null;
    batchId: string | null;
  } {
    try {
      const tx = iface.parseTransaction({ data });
      if (!tx) return { methodName: null, productId: null, batchId: null };
      const productId = typeof tx.args?.productId === 'string' ? tx.args.productId : null;
      const batchId = typeof tx.args?.batchId === 'string' ? tx.args.batchId : null;
      return { methodName: tx.name, productId, batchId };
    } catch {
      return { methodName: null, productId: null, batchId: null };
    }
  }

  private async tryDecodeRevert(
    tx: ethers.TransactionResponse,
    blockNumber: number,
  ): Promise<{ decodedError: string | null; rawData: string | null }> {
    try {
      await this.rpcPool.execute((p) =>
        p.call({
          to: tx.to ?? undefined,
          from: tx.from,
          data: tx.data,
          blockTag: blockNumber,
        }),
      );
      return { decodedError: 'Reverted on-chain', rawData: null };
    } catch (err: unknown) {
      const anyErr = err as {
        data?: string;
        shortMessage?: string;
        message?: string;
        revert?: { name?: string };
        info?: { error?: { data?: string | { data?: string; message?: string }; message?: string } };
      };
      if (anyErr?.revert?.name) {
        return { decodedError: anyErr.revert.name, rawData: anyErr.data ?? null };
      }
      const nestedData =
        typeof anyErr?.info?.error?.data === 'string'
          ? anyErr.info.error.data
          : anyErr?.info?.error?.data?.data;
      const rawData =
        typeof anyErr?.data === 'string'
          ? anyErr.data
          : typeof nestedData === 'string'
            ? nestedData
            : null;
      if (rawData && rawData.startsWith('0x')) {
        try {
          const parsedErr = iface.parseError(rawData);
          if (parsedErr) {
            return { decodedError: parsedErr.name, rawData };
          }
        } catch {
          // ignore
        }
      }
      const nestedMsg =
        typeof anyErr?.info?.error?.data === 'object'
          ? anyErr.info.error.data?.message
          : anyErr?.info?.error?.message;
      const fullMsg = nestedMsg || anyErr?.shortMessage || anyErr?.message || 'Transaction reverted';
      const customErrMatch = fullMsg.match(/reverted with custom error '([A-Za-z0-9_]+)/);
      return {
        decodedError: customErrMatch ? customErrMatch[1] : fullMsg.slice(0, 500),
        rawData,
      };
    }
  }

  private isLogRangeError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes('block range') ||
      msg.includes('more than 10000') ||
      msg.includes('log response size') ||
      msg.includes('query returned more')
    );
  }
}
