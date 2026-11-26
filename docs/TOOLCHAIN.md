# ChainTrace Enterprise — Toolchain & Monorepo Consistency

## 1. Runtime & Package Manager

| Component | Requirement / Version | Notes |
| :--- | :--- | :--- |
| **Node.js** | `>=20.0.0` (CI: `22`, Local verified: `v24.18.0`) | Pure-JS QR/Merkle libraries avoid Windows `node-gyp` native build failures on Node 24 |
| **npm** | `>=10.0.0` (Local verified: `12.0.2`) | Uses npm workspaces (`packages/*`, `apps/*`) |
| **Docker / Compose** | Docker `29.8.0`, Compose `v5.5.1` | Runs PostgreSQL `16-alpine` and IPFS Kubo `v0.32.1` |

## 2. Smart Contract Toolchain (`@chaintrace/contracts`)

| Dependency | Declared Range | Locked Version | Purpose |
| :--- | :--- | :--- | :--- |
| `hardhat` | `^2.28.0` | `2.30.0` | Local EVM, compilation, testing, coverage |
| `@nomicfoundation/hardhat-toolbox` | `^6.1.0` | `6.1.1` | Ethers v6, Chai matchers, TypeChain, Gas Reporter, `solidity-coverage` |
| `@openzeppelin/contracts` | `^5.3.0` | `5.6.1` | `AccessControl`, `EIP712`, `ECDSA`, `MerkleProof`, `ReentrancyGuard` |
| Solidity Compiler | `0.8.28` (`evmVersion: cancun`, `viaIR: true`, `optimizer: 200`) | `0.8.28` | Required for OpenZeppelin v5.6+ `mcopy` support |

## 3. Application Workspaces

- **`@chaintrace/shared`**: `ethers@^6.14.0`, `zod@^3.24.2`, `jest@^29.7.0`, `ts-jest@^29.2.5`, `typescript@^5.8.2`
- **`@chaintrace/indexer`**: `@chaintrace/shared`, `ethers@^6.14.0`, `pg@^8.13.1`, `zod@^3.24.2`, `jest@^29.7.0`
- **`@chaintrace/api`**: `@chaintrace/shared`, `express@^4.21.2`, `siwe@^3.0.0`, `jsonwebtoken@^9.0.2`, `helmet@^8.0.0`, `express-rate-limit@^7.5.0`, `pg@^8.13.1`, `qrcode@^1.5.4`, `supertest@^7.0.0`
- **`@chaintrace/web`**: `@chaintrace/shared`, `next@^15.3.2` (`15.5.29`), `react@^19.1.0`, `ethers@^6.14.0`, `jsqr@^1.4.0`, `qrcode@^1.5.4`, `tailwindcss@^3.4.17`

## 4. Verification Commands

```bash
npm run lint
npm run typecheck
npm run build
npm run test --workspace=@chaintrace/shared
npm run test --workspace=@chaintrace/contracts
npm run contracts:coverage
npm run test --workspace=@chaintrace/indexer -- --runInBand
npm run test --workspace=@chaintrace/api -- --runInBand
```
