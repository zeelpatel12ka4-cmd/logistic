import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { Pool } from 'pg';
import { IpfsClient, RpcFailoverPool } from '@chaintrace/shared';
import { AppConfig } from './config';
import { isDbHealthy } from './db/pool';
import { errorHandler } from './middleware/errorHandler';
import { AuthService } from './services/authService';
import { BatchService } from './services/batchService';
import { createAuthRouter } from './routes/auth';
import { createBatchesRouter } from './routes/batches';
import { createProductsRouter } from './routes/products';
import { createExplorerRouter } from './routes/explorer';
import { createVerifyRouter } from './routes/verify';
import { createRelayerRouter, RelayerQueueService } from './routes/relayer';
import { openApiSpec } from './docs/openapi';

export interface AppDependencies {
  config: AppConfig;
  pool: Pool;
  rpcPool: RpcFailoverPool;
  ipfsClient: IpfsClient;
}

export function createApp(deps: AppDependencies) {
  const { config, pool, rpcPool, ipfsClient } = deps;
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'chaintrace-api' });
  });

  app.get('/health/ready', async (_req, res) => {
    const [dbOk, ipfsOk] = await Promise.all([isDbHealthy(pool), ipfsClient.isHealthy()]);
    let rpcOk = false;
    try {
      await rpcPool.execute((p) => p.getBlockNumber());
      rpcOk = true;
    } catch {
      rpcOk = false;
    }
    const status = dbOk && rpcOk ? 200 : 503;
    res.status(status).json({
      status: status === 200 ? 'ready' : 'degraded',
      dependencies: {
        postgres: dbOk,
        ipfs: ipfsOk,
        rpc: rpcOk,
        rpcEndpoints: rpcPool.getHealthSnapshot(),
      },
    });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.status(200).json(openApiSpec);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  const authService = new AuthService(
    pool,
    rpcPool,
    config.contractAddress,
    config.jwtSecret,
    config.chainId,
  );
  const batchService = new BatchService(
    pool,
    ipfsClient,
    config.chainId,
    config.contractAddress,
  );
  const relayerService = new RelayerQueueService(
    pool,
    rpcPool,
    config.contractAddress,
    config.relayerPrivateKey,
  );

  app.use('/api/auth', authLimiter, createAuthRouter(authService, config.jwtSecret));
  app.use('/api/batches', createBatchesRouter(pool, batchService, config.jwtSecret));
  app.use('/api/products', createProductsRouter(pool, batchService, config.jwtSecret));
  app.use(
    '/api/explorer',
    createExplorerRouter(pool, rpcPool, config.contractAddress, config.chainId),
  );
  app.use(
    '/api/verify',
    createVerifyRouter(
      pool,
      rpcPool,
      ipfsClient,
      batchService,
      config.contractAddress,
      config.chainId,
    ),
  );
  app.use('/api/relayer', createRelayerRouter(relayerService));

  app.use(errorHandler);
  return app;
}
