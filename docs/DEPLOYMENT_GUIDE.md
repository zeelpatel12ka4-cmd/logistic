# ChainTrace Enterprise — Deployment Guide

## 1. Local Infrastructure (Recommended)
PostgreSQL and IPFS bind exclusively to `127.0.0.1` in `docker-compose.yml` so admin ports are never exposed externally by default.

```bash
cp .env.example .env
npm install
npm run docker:infra
npm run chain:node
npm run contracts:deploy:local
npm run db:migrate
```

## 2. Production Security Requirements
Before deploying with `NODE_ENV=production` or `docker compose --profile full up --build -d`:
1. Generate a strong random `JWT_SECRET` (`>= 32` characters) — API startup fails closed if left at the dev default.
2. Generate a separate 32-byte hex `SECRET_ENCRYPTION_KEY` (`openssl rand -hex 32`) — API startup fails closed in production if missing. Never store this key in PostgreSQL.
3. Set `SIWE_DOMAIN` and `CORS_ORIGINS` to your exact HTTPS frontend origin.
4. Assign `DEFAULT_ADMIN_ROLE` on `ChainTraceRegistry` to a multisig wallet.
5. Both `Dockerfile.service` and `Dockerfile.web` run as non-root `USER node`.
