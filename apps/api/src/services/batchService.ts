import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import * as QRCode from 'qrcode';
import {
  buildMerkleTree,
  computeBatchId,
  computeClaimSecretHash,
  computeLeaf,
  computeProductId,
  CreateBatchRequest,
  CustodyStatus,
  IpfsClient,
  MerkleTreeInstance,
  QrPayload,
} from '@chaintrace/shared';
import { HttpError } from '../middleware/errorHandler';
import { decryptClaimSecret, encryptClaimSecret } from './secretCrypto';

export class BatchService {
  private readonly treeCache = new Map<string, MerkleTreeInstance>();
  private readonly maxCachedTrees = 4;

  constructor(
    private readonly pool: Pool,
    private readonly ipfsClient: IpfsClient,
    private readonly chainId: number,
    private readonly contractAddress: string,
    private readonly secretEncryptionKey: Buffer,
  ) {}

  private cacheTree(batchId: string, tree: MerkleTreeInstance): void {
    if (this.treeCache.has(batchId)) {
      this.treeCache.delete(batchId);
    } else if (this.treeCache.size >= this.maxCachedTrees) {
      const oldestKey = this.treeCache.keys().next().value;
      if (oldestKey) this.treeCache.delete(oldestKey);
    }
    this.treeCache.set(batchId, tree);
  }

  public async prepareBatch(manufacturerAddress: string, input: CreateBatchRequest) {
    const checksummedMfg = ethers.getAddress(manufacturerAddress);
    const batchId = computeBatchId(checksummedMfg, input.batchCode);

    const existing = await this.pool.query<{ batch_id: string }>(
      `SELECT batch_id FROM batches WHERE batch_id = $1`,
      [batchId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new HttpError(409, 'BATCH_EXISTS', `Batch code ${input.batchCode} already exists`);
    }

    const metadataDoc = {
      batchCode: input.batchCode,
      productName: input.productName,
      sku: input.sku,
      category: input.category,
      manufacturerName: input.manufacturerName,
      manufacturerAddress: checksummedMfg,
      description: input.description,
      serialPrefix: input.serialPrefix,
      unitCount: input.unitCount,
      specifications: input.specifications,
    };

    const pinResult = await this.ipfsClient.pinJson(metadataDoc);
    const metadataHash = pinResult.metadataHash;

    const leaves: string[] = new Array(input.unitCount);
    const rows: Array<{
      productId: string;
      serialNumber: string;
      leafIndex: number;
      encryptedSecret: string | null;
      claimSecretHash: string;
    }> = new Array(input.unitCount);

    for (let i = 0; i < input.unitCount; i++) {
      const paddedIdx = String(i + 1).padStart(6, '0');
      const serialNumber = `${input.serialPrefix}-${paddedIdx}`;
      const productId = computeProductId(checksummedMfg, batchId, serialNumber);
      const claimSecret = input.includeClaimSecrets
        ? `CT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`
        : null;
      const claimSecretHash = claimSecret ? computeClaimSecretHash(claimSecret) : ethers.ZeroHash;
      const encryptedSecret = claimSecret
        ? encryptClaimSecret(claimSecret, this.secretEncryptionKey)
        : null;

      leaves[i] = computeLeaf({
        batchId,
        productId,
        serialNumber,
        metadataHash,
        claimSecretHash,
      });

      rows[i] = {
        productId,
        serialNumber,
        leafIndex: i,
        encryptedSecret,
        claimSecretHash,
      };
    }

    const tree = buildMerkleTree(leaves);
    const storeProofsInline = input.unitCount <= 2000;
    if (!storeProofsInline) {
      this.cacheTree(batchId, tree);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO batches (
           batch_id, chain_id, batch_code, product_name, sku, category, manufacturer_name,
           serial_prefix, manufacturer_address, batch_custodian, merkle_root, ipfs_cid,
           unit_count, batch_status, previous_batch_status, onchain_confirmed,
           metadata_json, metadata_hash, metadata_verified
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$13,FALSE,$14,$15,TRUE)`,
        [
          batchId,
          this.chainId,
          input.batchCode,
          input.productName,
          input.sku,
          input.category,
          input.manufacturerName,
          input.serialPrefix,
          checksummedMfg,
          tree.root,
          pinResult.cid,
          input.unitCount,
          CustodyStatus.Manufactured,
          JSON.stringify(metadataDoc),
          metadataHash,
        ],
      );

      const chunkSize = 2500;
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const productIds = chunk.map((r) => r.productId);
        const serials = chunk.map((r) => r.serialNumber);
        const leafIndices = chunk.map((r) => r.leafIndex);
        const secretHashes = chunk.map((r) => r.claimSecretHash);
        const proofs = chunk.map((r) =>
          storeProofsInline ? JSON.stringify(tree.getProof(r.leafIndex)) : null,
        );

        await client.query(
          `INSERT INTO products (
             product_id, batch_id, serial_number, leaf_index, metadata_hash,
             claim_secret_hash, merkle_proof, current_custodian, custody_status, previous_status
           )
           SELECT u.product_id, $1, u.serial_number, u.leaf_index, $2,
                  u.claim_secret_hash, u.merkle_proof::jsonb, $3, $4, $4
           FROM UNNEST($5::text[], $6::text[], $7::int[], $8::text[], $9::text[])
             AS u(product_id, serial_number, leaf_index, claim_secret_hash, merkle_proof)`,
          [
            batchId,
            metadataHash,
            checksummedMfg,
            CustodyStatus.Manufactured,
            productIds,
            serials,
            leafIndices,
            secretHashes,
            proofs,
          ],
        );

        if (input.includeClaimSecrets) {
          const encryptedSecrets = chunk.map((r) => r.encryptedSecret as string);
          await client.query(
            `INSERT INTO product_secrets (product_id, claim_secret, encrypted_claim_secret)
             SELECT u.product_id, NULL, u.encrypted_claim_secret
             FROM UNNEST($1::text[], $2::text[]) AS u(product_id, encrypted_claim_secret)`,
            [productIds, encryptedSecrets],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      batchId,
      batchCode: input.batchCode,
      merkleRoot: tree.root,
      ipfsCid: pinResult.cid,
      metadataHash,
      unitCount: input.unitCount,
      contractCall: {
        method: 'registerBatch',
        args: [batchId, tree.root, pinResult.cid, input.unitCount],
      },
      sampleProducts: rows.slice(0, 5).map((r) => ({
        productId: r.productId,
        serialNumber: r.serialNumber,
        leafIndex: r.leafIndex,
        claimSecretHash: r.claimSecretHash,
        merkleProof: tree.getProof(r.leafIndex),
      })),
    };
  }

  public async getMerkleProofForProduct(batchId: string, productId: string): Promise<string[]> {
    const existing = await this.pool.query<{
      merkle_proof: string[] | null;
      leaf_index: number;
    }>(`SELECT merkle_proof, leaf_index FROM products WHERE product_id = $1 AND batch_id = $2`, [
      productId,
      batchId,
    ]);
    if (!existing.rowCount) {
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found in batch');
    }
    if (Array.isArray(existing.rows[0].merkle_proof)) {
      return existing.rows[0].merkle_proof;
    }

    const cachedTree = this.treeCache.get(batchId);
    if (cachedTree) {
      return cachedTree.getProof(existing.rows[0].leaf_index);
    }

    const allLeaves = await this.pool.query<{
      product_id: string;
      serial_number: string;
      metadata_hash: string;
      claim_secret_hash: string;
      leaf_index: number;
    }>(
      `SELECT product_id, serial_number, metadata_hash, claim_secret_hash, leaf_index
       FROM products WHERE batch_id = $1 ORDER BY leaf_index ASC`,
      [batchId],
    );
    const leaves = allLeaves.rows.map((r) =>
      computeLeaf({
        batchId,
        productId: r.product_id,
        serialNumber: r.serial_number,
        metadataHash: r.metadata_hash,
        claimSecretHash: r.claim_secret_hash,
      }),
    );
    const tree = buildMerkleTree(leaves);
    this.cacheTree(batchId, tree);
    return tree.getProof(existing.rows[0].leaf_index);
  }

  public async retireClaimSecret(productId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE product_secrets
       SET claim_secret = NULL,
           encrypted_claim_secret = NULL,
           retired_at = NOW(),
           retired_reason = $2
       WHERE product_id = $1 AND retired_at IS NULL`,
      [productId, reason],
    );
  }

  public async buildProductQrBundle(
    batchId: string,
    productId: string,
    includeSecret: boolean,
    actorWallet?: string,
  ): Promise<{ payload: QrPayload; qrDataUrl: string }> {
    const res = await this.pool.query<{
      product_id: string;
      batch_id: string;
      serial_number: string;
      metadata_hash: string;
      claim_secret_hash: string;
      claimed: boolean;
      encrypted_claim_secret: string | null;
      retired_at: string | null;
    }>(
      `SELECT p.product_id, p.batch_id, p.serial_number, p.metadata_hash, p.claim_secret_hash,
              p.claimed, ps.encrypted_claim_secret, ps.retired_at
       FROM products p
       LEFT JOIN product_secrets ps ON ps.product_id = p.product_id
       WHERE p.batch_id = $1 AND (p.product_id = $2 OR p.serial_number = $2)`,
      [batchId, productId],
    );

    if (!res.rowCount) {
      throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const row = res.rows[0];
    const proof = await this.getMerkleProofForProduct(row.batch_id, row.product_id);

    let claimSecret: string | undefined;
    if (includeSecret) {
      if (row.claimed || row.retired_at) {
        throw new HttpError(
          410,
          'CLAIM_SECRET_RETIRED',
          'Claim secret has been retired after product claim',
        );
      }
      if (row.encrypted_claim_secret) {
        claimSecret = decryptClaimSecret(row.encrypted_claim_secret, this.secretEncryptionKey);
      }
      if (actorWallet) {
        await this.pool.query(
          `INSERT INTO secret_access_logs (batch_id, product_id, actor_wallet, action)
           VALUES ($1, $2, $3, 'QR_SECRET_EXPORT')`,
          [row.batch_id, row.product_id, actorWallet],
        );
      }
    }

    const payload: QrPayload = {
      v: 1,
      chainId: this.chainId,
      contractAddress:
        this.contractAddress || '0x0000000000000000000000000000000000000000',
      batchId: row.batch_id,
      productId: row.product_id,
      serialNumber: row.serial_number,
      metadataHash: row.metadata_hash,
      claimSecretHash: row.claim_secret_hash,
      ...(claimSecret ? { claimSecret } : {}),
      merkleProof: proof,
    };

    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });

    return { payload, qrDataUrl };
  }
}
