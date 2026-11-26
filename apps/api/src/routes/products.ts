import { Router } from 'express';
import { Pool } from 'pg';
import { ShipmentNoteSchema, SupplyChainRole } from '@chaintrace/shared';
import { AuthenticatedRequest, requireAuth, requireLiveRoles } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { BatchService } from '../services/batchService';

export function createProductsRouter(
  pool: Pool,
  batchService: BatchService,
  jwtSecret: string,
  resolveRoles: (walletAddress: string) => Promise<SupplyChainRole[]>,
): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const custodian = typeof req.query.custodian === 'string' ? req.query.custodian.trim() : '';
      const pendingFor = typeof req.query.pendingFor === 'string' ? req.query.pendingFor.trim() : '';
      const status = req.query.status !== undefined ? Number(req.query.status) : null;
      const batchId = typeof req.query.batchId === 'string' ? req.query.batchId.trim() : '';
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (q) {
        if (q.startsWith('0x') && q.length === 66) {
          params.push(q);
          conditions.push(`p.product_id = $${params.length}`);
        } else if (q.startsWith('0x')) {
          params.push(`${q}%`);
          conditions.push(`p.product_id LIKE $${params.length}`);
        } else if (req.query.contains === 'true') {
          params.push(`%${q}%`);
          conditions.push(`p.serial_number ILIKE $${params.length}`);
        } else {
          params.push(`${q}%`);
          conditions.push(`p.serial_number LIKE $${params.length}`);
        }
      }
      if (custodian) {
        params.push(custodian);
        conditions.push(`LOWER(p.current_custodian) = LOWER($${params.length})`);
      }
      if (pendingFor) {
        params.push(pendingFor);
        conditions.push(`LOWER(p.pending_custodian) = LOWER($${params.length})`);
      }
      if (status !== null && !Number.isNaN(status)) {
        params.push(status);
        conditions.push(`p.custody_status = $${params.length}`);
      }
      if (batchId) {
        params.push(batchId);
        conditions.push(`p.batch_id = $${params.length}`);
      }
      if (cursor) {
        params.push(cursor);
        conditions.push(`p.product_id < $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit + 1);

      const rowsRes = await pool.query(
        `SELECT p.product_id, p.batch_id, p.serial_number, p.leaf_index, p.metadata_hash,
                p.claim_secret_hash, p.is_materialized, p.current_custodian, p.pending_custodian,
                p.custody_status, p.nonce, p.claimed, p.recalled, p.last_tx_hash, p.last_block_number,
                b.product_name, b.sku, b.batch_code, b.ipfs_cid, b.manufacturer_address, b.manufacturer_name
         FROM products p
         JOIN batches b ON b.batch_id = p.batch_id
         ${whereClause}
         ORDER BY p.product_id DESC
         LIMIT $${params.length}`,
        params,
      );

      const hasMore = rowsRes.rows.length > limit;
      const items = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;
      const nextCursor = hasMore ? items[items.length - 1].product_id : null;

      res.status(200).json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:productId', async (req, res, next) => {
    try {
      const identifier = req.params.productId;
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

      if (!prodRes.rowCount) {
        throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
      }

      const product = prodRes.rows[0];
      const merkleProof = await batchService.getMerkleProofForProduct(
        product.batch_id,
        product.product_id,
      );

      const eventsRes = await pool.query(
        `SELECT event_name, block_number, block_hash, tx_hash, log_index,
                from_address, to_address, status_code, nonce, payload, block_timestamp, is_finalized
         FROM product_events
         WHERE is_reorged = FALSE
           AND (product_id = $1 OR (batch_id = $2 AND product_id IS NULL))
         ORDER BY block_number ASC, log_index ASC`,
        [product.product_id, product.batch_id],
      );

      const shipmentsRes = await pool.query(
        `SELECT * FROM offchain_shipments
         WHERE product_id = $1 OR batch_id = $2
         ORDER BY created_at ASC`,
        [product.product_id, product.batch_id],
      );

      res.status(200).json({
        product: { ...product, merkle_proof: merkleProof },
        events: eventsRes.rows,
        shipments: shipmentsRes.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/shipments',
    requireAuth(jwtSecret),
    requireLiveRoles(resolveRoles, 'MANUFACTURER', 'DISTRIBUTOR', 'WAREHOUSE', 'RETAILER'),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const input = ShipmentNoteSchema.parse(req.body);
        const upsertRes = await pool.query(
          `INSERT INTO offchain_shipments (
             tx_hash, product_id, batch_id, submitted_by, carrier_name, tracking_number,
             origin_location, destination_location, temperature_range, notes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (tx_hash)
           DO UPDATE SET carrier_name = EXCLUDED.carrier_name,
                         tracking_number = EXCLUDED.tracking_number,
                         origin_location = EXCLUDED.origin_location,
                         destination_location = EXCLUDED.destination_location,
                         temperature_range = EXCLUDED.temperature_range,
                         notes = EXCLUDED.notes
           RETURNING *`,
          [
            input.txHash,
            input.productId ?? null,
            input.batchId ?? null,
            req.auth!.walletAddress,
            input.carrierName,
            input.trackingNumber,
            input.originLocation,
            input.destinationLocation,
            input.temperatureRange ?? null,
            input.notes ?? null,
          ],
        );
        res.status(201).json({ shipment: upsertRes.rows[0] });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
