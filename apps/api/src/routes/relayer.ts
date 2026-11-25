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

export class RelayerQueueService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Pool,
    private readonly rpcPool: RpcFailoverPool,
    private readonly contractAddress: string,
    private readonly relayerPrivateKey: string,
  ) {}

  public isEnabled(): boolean {
    return Boolean(this.relayerPrivateKey && this.contractAddress);
  }

  public async enqueueClaim(input: z.infer<typeof RelayerClaimSchema>) {
    if (!this.isEnabled()) {
      throw new HttpError(
        503,
        'RELAYER_DISABLED',
        'Optional gasless relayer is not enabled (RELAYER_PRIVATE_KEY not configured)',
      );
    }

    // Idempotent job claim via unique constraint
    try {
      await this.pool.query(
        `INSERT INTO relayer_jobs (idempotency_key, job_type, payload, status)
         VALUES ($1, 'CLAIM_BY_SIG', $2, 'PENDING')`,
        [input.idempotencyKey, JSON.stringify(input)],
      );
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        const existing = await this.pool.query(
          `SELECT idempotency_key, status, tx_hash, error_message FROM relayer_jobs WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        return { deduplicated: true, job: existing.rows[0] };
      }
      throw err;
    }

    // Serialize EVM nonce submission across concurrent callers
    const result = await new Promise<{ txHash: string }>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          const txHash = await this.rpcPool.execute(async (provider) => {
            const wallet = new ethers.Wallet(this.relayerPrivateKey, provider);
            const contract = new ethers.Contract(
              this.contractAddress,
              CHAIN_TRACE_REGISTRY_ABI,
              wallet,
            );
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
            );
            const receipt = await tx.wait();
            return receipt?.hash || tx.hash;
          });

          await this.pool.query(
            `UPDATE relayer_jobs SET status = 'CONFIRMED', tx_hash = $2, attempts = attempts + 1, updated_at = NOW()
             WHERE idempotency_key = $1`,
            [input.idempotencyKey, txHash],
          );
          resolve({ txHash });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.pool
            .query(
              `UPDATE relayer_jobs SET status = 'FAILED', error_message = $2, attempts = attempts + 1, updated_at = NOW()
               WHERE idempotency_key = $1`,
              [input.idempotencyKey, msg],
            )
            .catch(() => {});
          reject(err);
        }
      });
    });

    return { deduplicated: false, status: 'CONFIRMED', txHash: result.txHash };
  }
}

export function createRelayerRouter(relayerService: RelayerQueueService): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.status(200).json({ enabled: relayerService.isEnabled() });
  });

  router.post('/claim', async (req, res, next) => {
    try {
      const input = RelayerClaimSchema.parse(req.body);
      const outcome = await relayerService.enqueueClaim(input);
      res.status(200).json(outcome);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
