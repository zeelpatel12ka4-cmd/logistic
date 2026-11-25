import { Router } from 'express';
import { Pool } from 'pg';
import { Bytes32Schema, CreateBatchRequestSchema } from '@chaintrace/shared';
import { AuthenticatedRequest, requireAuth, requireRoles } from '../middleware/auth';
import { HttpError } from '../middleware/errorHandler';
import { BatchService } from '../services/batchService';

export function createBatchesRouter(
  pool: Pool,
  batchService: BatchService,
  jwtSecret: string,
): Router {
  const router = Router();

  router.post(
    '/prepare',
    requireAuth(jwtSecret),
    requireRoles('MANUFACTURER'),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const input = CreateBatchRequestSchema.parse(req.body);
        const result = await batchService.prepareBatch(req.auth!.walletAddress, input);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const manufacturer = typeof req.query.manufacturer === 'string' ? req.query.manufacturer : null;
      const custodian = typeof req.query.custodian === 'string' ? req.query.custodian : null;
      const pendingFor = typeof req.query.pendingFor === 'string' ? req.query.pendingFor : null;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (manufacturer) {
        params.push(manufacturer);
        conditions.push(`LOWER(manufacturer_address) = LOWER($${params.length})`);
      }
      if (custodian) {
        params.push(custodian);
        conditions.push(`LOWER(batch_custodian) = LOWER($${params.length})`);
      }
      if (pendingFor) {
        params.push(pendingFor);
        conditions.push(`LOWER(pending_batch_custodian) = LOWER($${params.length})`);
      }
      if (cursor) {
        params.push(cursor);
        conditions.push(`batch_id < $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit + 1);

      const rowsRes = await pool.query(
        `SELECT batch_id, chain_id, batch_code, product_name, sku, category, manufacturer_name,
                manufacturer_address, batch_custodian, pending_batch_custodian, merkle_root,
                ipfs_cid, unit_count, split_count, batch_nonce, batch_status, recalled,
                onchain_confirmed, tx_hash, block_number, is_finalized, created_at
         FROM batches
         ${whereClause}
         ORDER BY created_at DESC, batch_id DESC
         LIMIT $${params.length}`,
        params,
      );

      const hasMore = rowsRes.rows.length > limit;
      const items = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;
      const nextCursor = hasMore ? items[items.length - 1].batch_id : null;

      res.status(200).json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:batchId', async (req, res, next) => {
    try {
      const batchId = Bytes32Schema.parse(req.params.batchId);
      const batchRes = await pool.query(`SELECT * FROM batches WHERE batch_id = $1`, [batchId]);
      if (!batchRes.rowCount) {
        throw new HttpError(404, 'BATCH_NOT_FOUND', 'Batch not found');
      }

      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const productParams: unknown[] = [batchId];
      let cursorClause = '';
      if (cursor) {
        productParams.push(Number(cursor));
        cursorClause = `AND leaf_index > $2`;
      }
      productParams.push(limit + 1);

      const productsRes = await pool.query(
        `SELECT product_id, batch_id, serial_number, leaf_index, metadata_hash, claim_secret_hash,
                is_materialized, current_custodian, pending_custodian, custody_status, nonce,
                claimed, recalled, last_tx_hash, last_block_number
         FROM products
         WHERE batch_id = $1 ${cursorClause}
         ORDER BY leaf_index ASC
         LIMIT $${productParams.length}`,
        productParams,
      );

      const hasMore = productsRes.rows.length > limit;
      const products = hasMore ? productsRes.rows.slice(0, limit) : productsRes.rows;
      const nextCursor = hasMore ? String(products[products.length - 1].leaf_index) : null;

      res.status(200).json({
        batch: batchRes.rows[0],
        products,
        nextCursor,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/:batchId/products/:identifier/qr',
    requireAuth(jwtSecret),
    requireRoles('MANUFACTURER', 'ADMIN'),
    async (req: AuthenticatedRequest, res, next) => {
      try {
        const batchId = Bytes32Schema.parse(req.params.batchId);
        const identifier = req.params.identifier;
        const bundle = await batchService.buildProductQrBundle(batchId, identifier, true);
        res.status(200).json(bundle);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
