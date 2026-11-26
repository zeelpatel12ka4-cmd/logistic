import * as crypto from 'crypto';
import { Router } from 'express';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  Bytes32Schema,
  CHAIN_TRACE_REGISTRY_ABI,
  EvmAddressSchema,
  RpcFailoverPool,
} from '@chaintrace/shared';
import { HttpError } from '../middleware/errorHandler';

const RelayerClaimSchema = z.object({
  idempotencyKey: z.string().min(4).max(128),
  batchId: Bytes32Schema,
  productId: Bytes32Schema,
  serialNumber: z.string().min(1).max(128),
  metadataHash: Bytes32Schema,
  claimSecretHash: Bytes32Schema,
  merkleProof: z.array(Bytes32Schema),
  claimant: EvmAddressSchema,
  claimSecret: z.string().min(1).max(128),
  expectedNonce: z.number().int().min(0),
  deadline: z.number().int().positive(),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

export type RelayerClaimPayload = z.infer<typeof RelayerClaimSchema>;

export class RelayerQueueService {
  private readonly workerId = `worker-${crypto.randomBytes(4).toString('hex')}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly rpcPool: RpcFailoverPool,
    private readonly contractAddress: string,
    private readonly relayerPrivateKey: string,
  ) {}

  public isEnabled(): boolean {
    return Boolean(this.relayerPrivateKey && this.contractAddress);
  }

  public getSignerAddress(): string | null {
    if (!this.relayerPrivateKey) return null;
    return new ethers.Wallet(this.relayerPrivateKey).address;
  }

  public startWorker(pollIntervalMs = 2000): void {
    if (this.timer || !this.isEnabled()) return;
    this.timer = setInterval(() => {
      this.processOnce().catch(() => {});
    }, pollIntervalMs);
  }

  public stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async enqueueClaim(
    input: RelayerClaimPayload,
    options: { waitForCompletion?: boolean } = { waitForCompletion: true },
  ) {
    if (!this.isEnabled()) {
      throw new HttpError(
        503,
        'RELAYER_DISABLED',
        'Optional gasless relayer is not enabled (RELAYER_PRIVATE_KEY not configured)',
      );
    }

    try {
      await this.pool.query(
        `INSERT INTO relayer_jobs (idempotency_key, job_type, payload, status, next_run_at)
         VALUES ($1, 'CLAIM_BY_SIG', $2, 'PENDING', NOW())`,
        [input.idempotencyKey, JSON.stringify(input)],
      );
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        const existing = await this.pool.query(
          `SELECT idempotency_key, status, tx_hash, error_message, attempts
           FROM relayer_jobs WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        return { deduplicated: true, job: existing.rows[0] };
      }
      throw err;
    }

    if (options.waitForCompletion) {
      await this.processOnce();
      const jobRes = await this.pool.query(
        `SELECT idempotency_key, status, tx_hash, error_message, attempts
         FROM relayer_jobs WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const job = jobRes.rows[0];
      return {
        deduplicated: false,
        status: job?.status ?? 'PENDING',
        txHash: job?.tx_hash ?? null,
        job,
      };
    }

    return { deduplicated: false, status: 'PENDING', txHash: null };
  }

  public async processOnce(): Promise<number> {
    if (!this.isEnabled() || this.running) return 0;
    this.running = true;
    let processed = 0;

    try {
      while (true) {
        const job = await this.claimNextJob();
        if (!job) break;
        processed += 1;
        await this.executeJob(job);
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async claimNextJob(): Promise<{
    id: number;
    idempotency_key: string;
    payload: RelayerClaimPayload;
    attempts: number;
    max_attempts: number;
    tx_hash: string | null;
    signer_nonce: string | null;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{
        id: number;
        idempotency_key: string;
        payload: RelayerClaimPayload;
        attempts: number;
        max_attempts: number;
        tx_hash: string | null;
        signer_nonce: string | null;
      }>(
        `SELECT id, idempotency_key, payload, attempts, max_attempts, tx_hash, signer_nonce
         FROM relayer_jobs
         WHERE (status IN ('PENDING', 'RETRYING') AND next_run_at <= NOW())
            OR (status IN ('PROCESSING', 'SUBMITTED') AND locked_at < NOW() - INTERVAL '30 seconds')
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (!res.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const row = res.rows[0];
      await client.query(
        `UPDATE relayer_jobs
         SET status = 'PROCESSING', locked_by = $2, locked_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [row.id, this.workerId],
      );
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async allocateNonce(signerAddress: string, provider: ethers.Provider): Promise<number> {
    const chainPendingNonce = await provider.getTransactionCount(signerAddress, 'pending');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO relayer_signer_nonces (signer_address, next_nonce)
         VALUES ($1, $2)
         ON CONFLICT (signer_address) DO NOTHING`,
        [signerAddress, chainPendingNonce],
      );
      const row = await client.query<{ next_nonce: string }>(
        `SELECT next_nonce FROM relayer_signer_nonces WHERE signer_address = $1 FOR UPDATE`,
        [signerAddress],
      );
      const allocated = Math.max(Number(row.rows[0].next_nonce), chainPendingNonce);
      await client.query(
        `UPDATE relayer_signer_nonces SET next_nonce = $2, updated_at = NOW() WHERE signer_address = $1`,
        [signerAddress, allocated + 1],
      );
      await client.query('COMMIT');
      return allocated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async executeJob(job: {
    id: number;
    payload: RelayerClaimPayload;
    attempts: number;
    max_attempts: number;
    tx_hash: string | null;
    signer_nonce: string | null;
  }): Promise<void> {
    const input = job.payload;
    try {
      const txHash = await this.rpcPool.execute(async (provider) => {
        // Check if a previously submitted tx already confirmed on-chain (recovery after crash)
        if (job.tx_hash) {
          const existingReceipt = await provider.getTransactionReceipt(job.tx_hash);
          if (existingReceipt && existingReceipt.status === 1) {
            return existingReceipt.hash;
          }
        }

        const wallet = new ethers.Wallet(this.relayerPrivateKey, provider);
        const contract = new ethers.Contract(
          this.contractAddress,
          CHAIN_TRACE_REGISTRY_ABI,
          wallet,
        );

        const nonce =
          job.signer_nonce !== null
            ? Number(job.signer_nonce)
            : await this.allocateNonce(wallet.address, provider);

        const feeData = await provider.getFeeData();
        const bumpFactor = job.attempts > 0 ? BigInt(100 + job.attempts * 15) : 100n;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
          ? (feeData.maxPriorityFeePerGas * bumpFactor) / 100n
          : undefined;
        const maxFeePerGas = feeData.maxFeePerGas
          ? (feeData.maxFeePerGas * bumpFactor) / 100n
          : undefined;

        const tx = await contract.claimProductBySig(
          input.batchId,
          input.productId,
          input.serialNumber,
          input.metadataHash,
          input.claimSecretHash,
          input.merkleProof,
          input.claimant,
          input.claimSecret,
          input.expectedNonce,
          input.deadline,
          input.signature,
          {
            nonce,
            ...(maxPriorityFeePerGas ? { maxPriorityFeePerGas } : {}),
            ...(maxFeePerGas ? { maxFeePerGas } : {}),
          },
        );

        await this.pool.query(
          `UPDATE relayer_jobs
           SET status = 'SUBMITTED', tx_hash = $2, signer_address = $3, signer_nonce = $4, updated_at = NOW()
           WHERE id = $1`,
          [job.id, tx.hash, wallet.address, nonce],
        );

        const receipt = await tx.wait(1);
        if (!receipt || receipt.status !== 1) {
          throw new Error('Relayer transaction reverted on-chain');
        }
        return receipt.hash;
      });

      await this.pool.query(
        `UPDATE relayer_jobs
         SET status = 'CONFIRMED', tx_hash = $2, confirmed_at = NOW(), attempts = attempts + 1, locked_by = NULL, updated_at = NOW()
         WHERE id = $1`,
        [job.id, txHash],
      );
    } catch (err) {
      const nextAttempt = job.attempts + 1;
      const isRevert =
        (err as { code?: string })?.code === 'CALL_EXCEPTION' ||
        (err as { code?: string })?.code === 'INVALID_ARGUMENT';
      const exhausted = isRevert || nextAttempt >= job.max_attempts;
      const backoffSec = Math.min(60, Math.pow(2, nextAttempt));
      const safeMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);

      await this.pool.query(
        `UPDATE relayer_jobs
         SET status = $2,
             attempts = $3,
             error_message = $4,
             next_run_at = NOW() + ($5 || ' seconds')::interval,
             locked_by = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, exhausted ? 'DEAD_LETTER' : 'RETRYING', nextAttempt, safeMessage, String(backoffSec)],
      );
    }
  }

  public async getHealthStatus() {
    const signerAddress = this.getSignerAddress();
    let balanceEth: string | null = null;
    let lowBalanceWarning = false;

    if (signerAddress) {
      try {
        const wei = await this.rpcPool.execute((p) => p.getBalance(signerAddress));
        balanceEth = ethers.formatEther(wei);
        lowBalanceWarning = Number(balanceEth) < 0.05;
      } catch {
        balanceEth = null;
      }
    }

    const countsRes = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM relayer_jobs GROUP BY status`,
    );
    const jobCounts = Object.fromEntries(countsRes.rows.map((r) => [r.status, Number(r.count)]));

    return {
      enabled: this.isEnabled(),
      signerAddress,
      balanceEth,
      lowBalanceWarning,
      jobCounts,
    };
  }
}

export function createRelayerRouter(relayerService: RelayerQueueService): Router {
  const router = Router();

  router.get('/status', async (_req, res, next) => {
    try {
      res.status(200).json(await relayerService.getHealthStatus());
    } catch (err) {
      next(err);
    }
  });

  router.post('/claim', async (req, res, next) => {
    try {
      const input = RelayerClaimSchema.parse(req.body);
      const outcome = await relayerService.enqueueClaim(input, { waitForCompletion: true });
      res.status(outcome.status === 'CONFIRMED' || outcome.deduplicated ? 200 : 202).json(outcome);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
