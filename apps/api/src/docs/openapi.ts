export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ChainTrace Enterprise API',
    version: '1.0.0',
    description:
      'REST API for ChainTrace Enterprise decentralized supply chain tracking, Merkle batch generation, IPFS anchoring, SIWE auth, explorer telemetry, and dual-mode product verification.',
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local API server' }],
  paths: {
    '/health/live': {
      get: { summary: 'Liveness probe', responses: { '200': { description: 'Service is alive' } } },
    },
    '/health/ready': {
      get: {
        summary: 'Readiness probe (PostgreSQL, IPFS, RPC Failover Pool)',
        responses: {
          '200': { description: 'All critical dependencies healthy' },
          '503': { description: 'Degraded or unavailable dependency' },
        },
      },
    },
    '/api/auth/nonce': {
      post: {
        summary: 'Issue cryptographic single-use SIWE nonce',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { walletAddress: { type: 'string' } }, required: ['walletAddress'] },
            },
          },
        },
        responses: { '200': { description: 'Nonce issued' } },
      },
    },
    '/api/auth/verify': {
      post: {
        summary: 'Verify EIP-4361 SIWE signature and issue JWT session synced with on-chain roles',
        responses: { '200': { description: 'Authenticated session' }, '401': { description: 'Invalid nonce or signature' } },
      },
    },
    '/api/batches/prepare': {
      post: {
        summary: 'Generate product IDs, sealed claim secrets, Merkle root, and pin metadata to IPFS (Manufacturer only)',
        responses: { '201': { description: 'Batch prepared for on-chain registerBatch' } },
      },
    },
    '/api/batches': {
      get: { summary: 'Cursor-paginated list of batches', responses: { '200': { description: 'Batches list' } } },
    },
    '/api/products': {
      get: { summary: 'Keyset cursor-paginated & trigram-searchable product inventory', responses: { '200': { description: 'Products list' } } },
    },
    '/api/products/shipments': {
      post: { summary: 'Attach off-chain logistics tracking metadata keyed by txHash', responses: { '201': { description: 'Shipment saved' } } },
    },
    '/api/explorer/overview': {
      get: { summary: 'Blockchain explorer metrics, indexer lag, and RPC circuit-breaker telemetry', responses: { '200': { description: 'Overview telemetry' } } },
    },
    '/api/explorer/anomalies': {
      get: { summary: 'Reverted unauthorized calls, chain reorgs, suspicious duplicate scans, and live DB-vs-Chain tamper diff', responses: { '200': { description: 'Anomaly feed' } } },
    },
    '/api/verify/{identifier}': {
      get: {
        summary: 'Public product authenticity verification with stateless RPC fallback when PostgreSQL is offline',
        parameters: [{ name: 'identifier', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Verification verdict & lifecycle timeline' } },
      },
    },
    '/api/verify/qr': {
      post: { summary: 'Verify scanned QR JSON payload cryptographically against Merkle proof and live smart contract', responses: { '200': { description: 'QR verification result' } } },
    },
  },
};
