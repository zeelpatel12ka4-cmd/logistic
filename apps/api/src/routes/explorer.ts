import { Router } from 'express';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import {
  Bytes32Schema,
  CHAIN_TRACE_REGISTRY_ABI,
  RpcFailoverPool,
} from '@chaintrace/shared';

const iface = new ethers.Interface(CHAIN_TRACE_REGISTRY_ABI);

export function createExplorerRouter(
  pool: Pool,
  rpcPool: RpcFailoverPool,
  contractAddress: string,
  chainId: number,
): Router {
  const router = Router();

  router.get('/overview', async (_req, res, next) => {
    try {
      const [
        batchStats,
        productStats,
        eventStats,
        failedStats,
        reorgStats,
        scanStats,
        checkpointRes,
      ] = await Promise.all([
        pool.query<{ total_batches: string; total_units: string; recalled_batches: string }>(
          `SELECT COUNT(*)::text AS total_batches,
                  COALESCE(SUM(unit_count), 0)::text AS total_units,
                  COUNT(*) FILTER (WHERE recalled = TRUE)::text AS recalled_batches
           FROM batches WHERE onchain_confirmed = TRUE`,
        ),
        pool.query<{
          indexed_products: string;
          materialized_products: string;
          claimed_products: string;
        }>(
          `SELECT COUNT(*)::text AS indexed_products,
                  COUNT(*) FILTER (WHERE is_materialized = TRUE)::text AS materialized_products,
                  COUNT(*) FILTER (WHERE claimed = TRUE)::text AS claimed_products
           FROM products`,
        ),
        pool.query<{ canonical_events: string; reorged_events: string }>(
          `SELECT COUNT(*) FILTER (WHERE is_reorged = FALSE)::text AS canonical_events,
                  COUNT(*) FILTER (WHERE is_reorged = TRUE)::text AS reorged_events
           FROM product_events`,
        ),
        pool.query<{ failed_txs: string }>(
          `SELECT COUNT(*) FILTER (WHERE is_reorged = FALSE)::text AS failed_txs FROM failed_transactions`,
        ),
        pool.query<{ reorgs: string }>(`SELECT COUNT(*)::text AS reorgs FROM reorg_events`),
        pool.query<{ suspicious_scans: string }>(
          `SELECT COUNT(*) FILTER (WHERE is_suspicious = TRUE)::text AS suspicious_scans FROM scan_logs`,
        ),
        pool.query(
          `SELECT last_indexed_block, last_indexed_hash, last_finalized_block, updated_at
           FROM indexer_checkpoints WHERE chain_id = $1 LIMIT 1`,
          [chainId],
        ),
      ]);

      let chainTip: number | null = null;
      try {
        chainTip = await rpcPool.execute((p) => p.getBlockNumber());
      } catch {
        chainTip = null;
      }

      const checkpoint = checkpointRes.rows[0] ?? null;
      res.status(200).json({
        chainId,
        contractAddress,
        chainTip,
        indexerLagBlocks:
          chainTip !== null && checkpoint
            ? Math.max(0, chainTip - Number(checkpoint.last_indexed_block))
            : null,
        checkpoint,
        stats: {
          totalBatches: Number(batchStats.rows[0]?.total_batches ?? 0),
          totalUnitsAnchored: Number(batchStats.rows[0]?.total_units ?? 0),
          recalledBatches: Number(batchStats.rows[0]?.recalled_batches ?? 0),
          indexedProducts: Number(productStats.rows[0]?.indexed_products ?? 0),
          materializedProducts: Number(productStats.rows[0]?.materialized_products ?? 0),
          claimedProducts: Number(productStats.rows[0]?.claimed_products ?? 0),
          canonicalEvents: Number(eventStats.rows[0]?.canonical_events ?? 0),
          reorgedEvents: Number(eventStats.rows[0]?.reorged_events ?? 0),
          failedTransactions: Number(failedStats.rows[0]?.failed_txs ?? 0),
          reorgEvents: Number(reorgStats.rows[0]?.reorgs ?? 0),
          suspiciousScans: Number(scanStats.rows[0]?.suspicious_scans ?? 0),
        },
        rpcHealth: rpcPool.getHealthSnapshot(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30)));
      const includeReorged = req.query.includeReorged === 'true';
      const eventName = typeof req.query.eventName === 'string' ? req.query.eventName.trim() : '';
      const batchId = typeof req.query.batchId === 'string' ? req.query.batchId.trim() : '';
      const productId = typeof req.query.productId === 'string' ? req.query.productId.trim() : '';
      const beforeId = req.query.beforeId ? Number(req.query.beforeId) : null;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (!includeReorged) {
        conditions.push(`is_reorged = FALSE`);
      }
      if (eventName) {
        params.push(eventName);
        conditions.push(`event_name = $${params.length}`);
      }
      if (batchId) {
        params.push(batchId);
        conditions.push(`batch_id = $${params.length}`);
      }
      if (productId) {
        params.push(productId);
        conditions.push(`product_id = $${params.length}`);
      }
      if (beforeId !== null && !Number.isNaN(beforeId)) {
        params.push(beforeId);
        conditions.push(`id < $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit + 1);

      const rowsRes = await pool.query(
        `SELECT * FROM product_events
         ${whereClause}
         ORDER BY block_number DESC, log_index DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );

      const hasMore = rowsRes.rows.length > limit;
      const items = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;
      const nextCursor = hasMore ? String(items[items.length - 1].id) : null;

      res.status(200).json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/tx/:txHash', async (req, res, next) => {
    try {
      const txHash = Bytes32Schema.parse(req.params.txHash);
      const [eventsRes, failedRes, shipmentRes] = await Promise.all([
        pool.query(`SELECT * FROM product_events WHERE tx_hash = $1 ORDER BY log_index ASC`, [
          txHash,
        ]),
        pool.query(`SELECT * FROM failed_transactions WHERE tx_hash = $1`, [txHash]),
        pool.query(`SELECT * FROM offchain_shipments WHERE tx_hash = $1`, [txHash]),
      ]);

      let onChain: unknown = null;
      let rpcReachable = true;
      try {
        onChain = await rpcPool.execute(async (provider) => {
          const [tx, receipt] = await Promise.all([
            provider.getTransaction(txHash),
            provider.getTransactionReceipt(txHash),
          ]);
          if (!tx) return null;
          const decodedLogs = (receipt?.logs ?? [])
            .map((l) => {
              try {
                const parsed = iface.parseLog({ topics: [...l.topics], data: l.data });
                return parsed
                  ? {
                      name: parsed.name,
                      logIndex: l.index,
                      args: Object.fromEntries(
                        Object.entries(parsed.args.toObject()).map(([k, v]) => [
                          k,
                          typeof v === 'bigint' ? v.toString() : v,
                        ]),
                      ),
                    }
                  : null;
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          let methodName: string | null = null;
          try {
            methodName = iface.parseTransaction({ data: tx.data })?.name ?? null;
          } catch {
            methodName = null;
          }

          return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            nonce: tx.nonce,
            blockNumber: receipt?.blockNumber ?? tx.blockNumber,
            blockHash: receipt?.blockHash ?? tx.blockHash,
            status: receipt ? (receipt.status === 1 ? 'CONFIRMED' : 'REVERTED') : 'PENDING',
            gasUsed: receipt?.gasUsed.toString() ?? null,
            methodName,
            decodedLogs,
          };
        });
      } catch {
        rpcReachable = false;
      }

      res.status(200).json({
        txHash,
        rpcReachable,
        onChain,
        indexedEvents: eventsRes.rows,
        failedRecord: failedRes.rows[0] ?? null,
        offchainShipment: shipmentRes.rows[0] ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/anomalies', async (_req, res, next) => {
    try {
      const [failedRes, reorgRes, scansRes, recentBatchesRes] = await Promise.all([
        pool.query(
          `SELECT * FROM failed_transactions WHERE is_reorged = FALSE ORDER BY block_number DESC LIMIT 50`,
        ),
        pool.query(`SELECT * FROM reorg_events ORDER BY detected_at DESC LIMIT 20`),
        pool.query(
          `SELECT * FROM scan_logs WHERE is_suspicious = TRUE ORDER BY scanned_at DESC LIMIT 50`,
        ),
        pool.query<{
          batch_id: string;
          merkle_root: string;
          ipfs_cid: string;
          batch_custodian: string;
          recalled: boolean;
          onchain_confirmed: boolean;
        }>(
          `SELECT batch_id, merkle_root, ipfs_cid, batch_custodian, recalled, onchain_confirmed
           FROM batches WHERE onchain_confirmed = TRUE ORDER BY updated_at DESC LIMIT 20`,
        ),
      ]);

      // Live DB-vs-Chain tamper integrity audit
      const integrityMismatches: Array<{
        entityType: 'BATCH';
        id: string;
        field: string;
        dbValue: unknown;
        chainValue: unknown;
      }> = [];

      if (contractAddress && recentBatchesRes.rows.length > 0) {
        try {
          await rpcPool.execute(async (provider) => {
            const contract = new ethers.Contract(
              contractAddress,
              CHAIN_TRACE_REGISTRY_ABI,
              provider,
            );
            for (const b of recentBatchesRes.rows) {
              try {
                const chainBatch = await contract.getBatch(b.batch_id);
                if (chainBatch.merkleRoot.toLowerCase() !== b.merkle_root.toLowerCase()) {
                  integrityMismatches.push({
                    entityType: 'BATCH',
                    id: b.batch_id,
                    field: 'merkleRoot',
                    dbValue: b.merkle_root,
                    chainValue: chainBatch.merkleRoot,
                  });
                }
                if (chainBatch.batchCustodian.toLowerCase() !== b.batch_custodian.toLowerCase()) {
                  integrityMismatches.push({
                    entityType: 'BATCH',
                    id: b.batch_id,
                    field: 'batchCustodian',
                    dbValue: b.batch_custodian,
                    chainValue: chainBatch.batchCustodian,
                  });
                }
                if (Boolean(chainBatch.recalled) !== Boolean(b.recalled)) {
                  integrityMismatches.push({
                    entityType: 'BATCH',
                    id: b.batch_id,
                    field: 'recalled',
                    dbValue: b.recalled,
                    chainValue: Boolean(chainBatch.recalled),
                  });
                }
              } catch {
                integrityMismatches.push({
                  entityType: 'BATCH',
                  id: b.batch_id,
                  field: 'existence',
                  dbValue: 'onchain_confirmed=true',
                  chainValue: 'NOT_FOUND_ON_CHAIN',
                });
              }
            }
          });
        } catch {
          // RPC unavailable: omit live diff silently while returning persisted anomalies
        }
      }

      res.status(200).json({
        failedTransactions: failedRes.rows,
        reorgEvents: reorgRes.rows,
        suspiciousScans: scansRes.rows,
        integrityMismatches,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
