import { Router } from 'express';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  CHAIN_TRACE_REGISTRY_ABI,
  computeLeaf,
  CUSTODY_STATUS_LABELS,
  IpfsClient,
  QrPayloadSchema,
  RpcFailoverPool,
  verifyMerkleProof,
} from '@chaintrace/shared';
import { HttpError } from '../middleware/errorHandler';
import { BatchService } from '../services/batchService';

const VerifyQrBodySchema = z.object({
  qrPayload: QrPayloadSchema,
  claimSecret: z.string().optional(),
  scannerRegion: z.string().max(128).default('Web Portal'),
  clientFingerprint: z.string().max(128).optional(),
});

interface OnChainVerification {
  isMerkleValid: boolean;
  isInitialized: boolean;
  isRecalled: boolean;
  isClaimed: boolean;
  currentCustodian: string;
  pendingCustodian: string;
  currentStatus: number;
  currentStatusLabel: string;
  currentNonce: number;
  manufacturer: string;
  ipfsCid: string;
}

export function createVerifyRouter(
  pool: Pool,
  rpcPool: RpcFailoverPool,
  ipfsClient: IpfsClient,
  batchService: BatchService,
  contractAddress: string,
  chainId: number,
): Router {
  const router = Router();

  async function queryOnChainAuthenticity(
    targetContract: string,
    params: {
      batchId: string;
      productId: string;
      serialNumber: string;
      metadataHash: string;
      claimSecretHash: string;
      merkleProof: string[];
    },
  ): Promise<OnChainVerification> {
    return rpcPool.execute(async (provider) => {
      const contract = new ethers.Contract(targetContract, CHAIN_TRACE_REGISTRY_ABI, provider);
      const res = await contract.verifyProductAuthenticity(
        params.batchId,
        params.productId,
        params.serialNumber,
        params.metadataHash,
        params.claimSecretHash,
        params.merkleProof,
      );
      const statusNum = Number(res.currentStatus);
      return {
        isMerkleValid: Boolean(res.isMerkleValid),
        isInitialized: Boolean(res.isInitialized),
        isRecalled: Boolean(res.isRecalled),
        isClaimed: Boolean(res.isClaimed),
        currentCustodian: res.currentCustodian,
        pendingCustodian: res.pendingCustodian,
        currentStatus: statusNum,
        currentStatusLabel: CUSTODY_STATUS_LABELS[statusNum] ?? 'Unknown',
        currentNonce: Number(res.currentNonce),
        manufacturer: res.manufacturer,
        ipfsCid: res.ipfsCid,
      };
    });
  }

  async function runStatelessDirectVerify(params: {
    batchId: string;
    productId: string;
    serialNumber: string;
    metadataHash: string;
    claimSecretHash: string;
    merkleProof: string[];
    source: 'CHAIN_DIRECT_DB_DEGRADED' | 'CHAIN_DIRECT';
  }) {
    if (!contractAddress) {
      throw new HttpError(503, 'CONTRACT_UNCONFIGURED', 'Smart contract address is not configured');
    }
    const onChain = await queryOnChainAuthenticity(contractAddress, params);
    let ipfsMetadata: unknown = null;
    let ipfsIntegrityVerified = false;
    let ipfsStatus = 'METADATA_UNAVAILABLE';
    if (onChain.ipfsCid) {
      const fetched = await ipfsClient.fetchAndVerifyJson(onChain.ipfsCid, params.metadataHash);
      ipfsMetadata = fetched.data;
      ipfsIntegrityVerified = fetched.verified;
      ipfsStatus = fetched.status;
    }

    const verdict = !onChain.isMerkleValid
      ? 'INVALID_MERKLE_PROOF'
      : onChain.isRecalled
        ? 'RECALLED'
        : onChain.isClaimed
          ? 'CLAIMED_AUTHENTIC'
          : 'VERIFIED_AUTHENTIC';

    return {
      verdict,
      source: params.source,
      physicalAuthenticityNote:
        'Cryptographic verification confirms the digital commitment only; it does not independently prove physical tamper-evidence of packaging.',
      warning:
        params.source === 'CHAIN_DIRECT_DB_DEGRADED'
          ? 'PostgreSQL is offline; ownership was verified directly against the blockchain.'
          : null,
      product: {
        productId: params.productId,
        batchId: params.batchId,
        serialNumber: params.serialNumber,
        metadataHash: params.metadataHash,
        claimSecretHash: params.claimSecretHash,
        merkleProof: params.merkleProof,
      },
      onChain,
      ipfs: {
        cid: onChain.ipfsCid,
        status: ipfsStatus,
        integrityVerified: ipfsIntegrityVerified,
        metadata: ipfsMetadata,
      },
      events: [],
      shipments: [],
      anomalies: [],
    };
  }

  router.get('/:identifier', async (req, res, next) => {
    try {
      const identifier = req.params.identifier.trim();
      const scannerRegion =
        typeof req.query.region === 'string' ? req.query.region.slice(0, 128) : 'Web Portal';

      let dbRow: Record<string, unknown> | null = null;
      let dbAvailable = true;

      try {
        const isHexId = /^0x[a-fA-F0-9]{64}$/.test(identifier);
        const prodRes = await pool.query(
          `SELECT p.*, b.batch_code, b.product_name, b.sku, b.category, b.manufacturer_name,
                  b.manufacturer_address, b.merkle_root, b.ipfs_cid, b.metadata_json,
                  b.recalled AS batch_recalled, b.onchain_confirmed
           FROM products p
           JOIN batches b ON b.batch_id = p.batch_id
           WHERE ${isHexId ? 'p.product_id = $1' : 'p.serial_number = $1'}
           LIMIT 1`,
          [identifier],
        );
        dbRow = prodRes.rows[0] ?? null;
      } catch {
        dbAvailable = false;
      }

      // Stateless degraded mode when PostgreSQL is unavailable
      if (!dbAvailable) {
        const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : '';
        const serialNumber =
          typeof req.query.serialNumber === 'string' ? req.query.serialNumber : '';
        const metadataHash =
          typeof req.query.metadataHash === 'string' ? req.query.metadataHash : '';
        const claimSecretHash =
          typeof req.query.claimSecretHash === 'string'
            ? req.query.claimSecretHash
            : ethers.ZeroHash;
        const proofParam =
          typeof req.query.merkleProof === 'string' ? JSON.parse(req.query.merkleProof) : [];

        if (batchId && serialNumber && metadataHash && identifier.startsWith('0x')) {
          const direct = await runStatelessDirectVerify({
            batchId,
            productId: identifier,
            serialNumber,
            metadataHash,
            claimSecretHash,
            merkleProof: proofParam,
            source: 'CHAIN_DIRECT_DB_DEGRADED',
          });
          res.status(200).json(direct);
          return;
        }

        throw new HttpError(
          503,
          'DATABASE_UNAVAILABLE',
          'Database is unavailable. Pass QR proof params or use Trustless Browser RPC Verify.',
        );
      }

      if (!dbRow) {
        throw new HttpError(404, 'PRODUCT_NOT_FOUND', `No product found matching ${identifier}`);
      }

      const productId = String(dbRow.product_id);
      const batchId = String(dbRow.batch_id);
      const merkleProof = await batchService.getMerkleProofForProduct(batchId, productId);

      let onChain: OnChainVerification | null = null;
      let rpcReachable = true;
      if (contractAddress) {
        try {
          onChain = await queryOnChainAuthenticity(contractAddress, {
            batchId,
            productId,
            serialNumber: String(dbRow.serial_number),
            metadataHash: String(dbRow.metadata_hash),
            claimSecretHash: String(dbRow.claim_secret_hash),
            merkleProof,
          });
        } catch {
          rpcReachable = false;
        }
      }

      const [eventsRes, shipmentsRes, recentScansRes] = await Promise.all([
        pool.query(
          `SELECT event_name, block_number, block_hash, tx_hash, log_index,
                  from_address, to_address, status_code, nonce, payload, block_timestamp, is_finalized
           FROM product_events
           WHERE is_reorged = FALSE
             AND (product_id = $1 OR (batch_id = $2 AND product_id IS NULL))
           ORDER BY block_number ASC, log_index ASC`,
          [productId, batchId],
        ),
        pool.query(
          `SELECT * FROM offchain_shipments WHERE product_id = $1 OR batch_id = $2 ORDER BY created_at ASC`,
          [productId, batchId],
        ),
        pool.query<{ id: string; scanner_region: string; scanned_at: string }>(
          `SELECT id, scanner_region, scanned_at FROM scan_logs
           WHERE product_id = $1 AND scanned_at > NOW() - INTERVAL '5 minutes'`,
          [productId],
        ),
      ]);

      const dbCustodian = String(dbRow.current_custodian).toLowerCase();
      const chainCustodian = onChain?.currentCustodian.toLowerCase();
      const dbMismatch = Boolean(
        onChain &&
          onChain.manufacturer !== ethers.ZeroAddress &&
          (dbCustodian !== chainCustodian ||
            Number(dbRow.custody_status) !== onChain.currentStatus ||
            Boolean(dbRow.recalled || dbRow.batch_recalled) !== onChain.isRecalled),
      );

      const isClaimed = onChain ? onChain.isClaimed : Boolean(dbRow.claimed);
      const isRecalled = onChain
        ? onChain.isRecalled
        : Boolean(dbRow.recalled || dbRow.batch_recalled);
      const highVelocityRegions = new Set(
        recentScansRes.rows.map((r) => r.scanner_region).concat(scannerRegion),
      );
      const suspiciousVelocity = highVelocityRegions.size >= 3 && recentScansRes.rows.length >= 4;
      const suspiciousDuplicateClaim = isClaimed && recentScansRes.rows.length >= 2;
      const isSuspicious = suspiciousVelocity || suspiciousDuplicateClaim;
      const anomalyReason = suspiciousDuplicateClaim
        ? 'Repeated verification scans detected on an already-claimed product (possible cloned QR)'
        : suspiciousVelocity
          ? 'High-velocity multi-region QR scans detected within 5 minutes'
          : null;

      await pool.query(
        `INSERT INTO scan_logs (product_id, scanner_region, was_already_claimed, is_suspicious, anomaly_reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [productId, scannerRegion, isClaimed, isSuspicious, anomalyReason],
      );

      const verdict = !rpcReachable
        ? 'RPC_UNAVAILABLE_CACHED'
        : onChain && !onChain.isMerkleValid
          ? 'INVALID_MERKLE_PROOF'
          : isRecalled
            ? 'RECALLED'
            : dbMismatch
              ? 'TAMPERED_MISMATCH'
              : isSuspicious
                ? 'SUSPICIOUS_DUPLICATE'
                : isClaimed
                  ? 'CLAIMED_AUTHENTIC'
                  : 'VERIFIED_AUTHENTIC';

      res.status(200).json({
        verdict,
        source: rpcReachable ? 'CHAIN_AND_INDEX' : 'INDEX_CACHE_RPC_OFFLINE',
        warning: !rpcReachable
          ? 'Blockchain RPC is currently unreachable; displaying cached indexed history (not live-verified).'
          : dbMismatch
            ? 'Database state diverges from canonical blockchain state — displaying authoritative chain ownership.'
            : anomalyReason,
        chainId,
        contractAddress,
        product: {
          productId,
          batchId,
          batchCode: dbRow.batch_code,
          serialNumber: dbRow.serial_number,
          productName: dbRow.product_name,
          sku: dbRow.sku,
          category: dbRow.category,
          manufacturerName: dbRow.manufacturer_name,
          manufacturerAddress: dbRow.manufacturer_address,
          merkleRoot: dbRow.merkle_root,
          metadataHash: dbRow.metadata_hash,
          claimSecretHash: dbRow.claim_secret_hash,
          merkleProof,
          ipfsCid: dbRow.ipfs_cid,
          metadata: dbRow.metadata_json,
          currentCustodian: onChain?.currentCustodian ?? dbRow.current_custodian,
          pendingCustodian: onChain?.pendingCustodian ?? dbRow.pending_custodian,
          currentStatus: onChain?.currentStatus ?? dbRow.custody_status,
          currentStatusLabel:
            CUSTODY_STATUS_LABELS[onChain?.currentStatus ?? Number(dbRow.custody_status)] ??
            'Unknown',
          currentNonce: onChain?.currentNonce ?? Number(dbRow.nonce),
          claimed: isClaimed,
          recalled: isRecalled,
        },
        onChain,
        dbMismatch,
        events: eventsRes.rows,
        shipments: shipmentsRes.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/qr', async (req, res, next) => {
    try {
      const { qrPayload, scannerRegion, clientFingerprint } = VerifyQrBodySchema.parse(req.body);
      const targetContract = qrPayload.contractAddress || contractAddress;
      if (!targetContract) {
        throw new HttpError(503, 'CONTRACT_UNCONFIGURED', 'No contract address configured');
      }

      const leaf = computeLeaf({
        batchId: qrPayload.batchId,
        productId: qrPayload.productId,
        serialNumber: qrPayload.serialNumber,
        metadataHash: qrPayload.metadataHash,
        claimSecretHash: qrPayload.claimSecretHash,
      });

      let onChain: OnChainVerification | null = null;
      let rpcReachable = true;
      try {
        onChain = await queryOnChainAuthenticity(targetContract, qrPayload);
      } catch {
        rpcReachable = false;
      }

      let dbAvailable = true;
      let dbProduct: Record<string, unknown> | null = null;
      let events: unknown[] = [];
      let shipments: unknown[] = [];

      try {
        const prodRes = await pool.query(
          `SELECT p.*, b.merkle_root, b.ipfs_cid, b.metadata_json, b.product_name, b.sku, b.manufacturer_name
           FROM products p JOIN batches b ON b.batch_id = p.batch_id
           WHERE p.product_id = $1`,
          [qrPayload.productId],
        );
        dbProduct = prodRes.rows[0] ?? null;

        if (dbProduct) {
          const [ev, sh] = await Promise.all([
            pool.query(
              `SELECT * FROM product_events
               WHERE is_reorged = FALSE AND (product_id = $1 OR (batch_id = $2 AND product_id IS NULL))
               ORDER BY block_number ASC, log_index ASC`,
              [qrPayload.productId, qrPayload.batchId],
            ),
            pool.query(
              `SELECT * FROM offchain_shipments WHERE product_id = $1 OR batch_id = $2`,
              [qrPayload.productId, qrPayload.batchId],
            ),
          ]);
          events = ev.rows;
          shipments = sh.rows;

          await pool.query(
            `INSERT INTO scan_logs (product_id, scanner_region, client_fingerprint, was_already_claimed, is_suspicious)
             VALUES ($1, $2, $3, $4, FALSE)`,
            [
              qrPayload.productId,
              scannerRegion,
              clientFingerprint ?? null,
              Boolean(onChain?.isClaimed ?? dbProduct.claimed),
            ],
          );
        }
      } catch {
        dbAvailable = false;
      }

      // Independent local Merkle check against DB root if RPC offline
      const localMerkleOk =
        dbProduct && typeof dbProduct.merkle_root === 'string'
          ? verifyMerkleProof(dbProduct.merkle_root, leaf, qrPayload.merkleProof)
          : null;

      const isMerkleValid = onChain ? onChain.isMerkleValid : Boolean(localMerkleOk);
      const verdict = !isMerkleValid
        ? 'INVALID_MERKLE_PROOF'
        : onChain?.isRecalled
          ? 'RECALLED'
          : !rpcReachable
            ? 'RPC_UNAVAILABLE_CACHED'
            : onChain?.isClaimed
              ? 'CLAIMED_AUTHENTIC'
              : 'VERIFIED_AUTHENTIC';

      res.status(200).json({
        verdict,
        source: !dbAvailable
          ? 'CHAIN_DIRECT_DB_DEGRADED'
          : rpcReachable
            ? 'CHAIN_AND_INDEX'
            : 'INDEX_CACHE_RPC_OFFLINE',
        leaf,
        onChain,
        dbProduct,
        events,
        shipments,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
