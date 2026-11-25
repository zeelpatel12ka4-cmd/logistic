# ChainTrace Enterprise — Smart Contract Test & Coverage Report

**Test Suite:** [ChainTraceRegistry.test.ts](file:///c:/Users/zeelp/OneDrive/Desktop/blockchain/packages/contracts/test/ChainTraceRegistry.test.ts)
**Framework:** Hardhat `2.30.0`, Solidity `0.8.28` (`cancun`), `solidity-coverage v0.8.17`

## 1. Test Cases Verified (`9 passing`)

1. `registers batches in constant O(1) gas regardless of 100 vs 1,000,000 unit count`
2. `rejects registration from non-manufacturer, duplicate batch, empty CID, or zero unitCount`
3. `completes Manufacturer -> Distributor -> Warehouse -> Retailer -> Customer Claim`
4. `supports whole-batch transfer and independent unit split afterward`
5. `prevents concurrent conflicting transfer via monotonic nonce and pending lock`
6. `rejects tampered Merkle proof, wrong claim secret, unauthorized custodian, and zero address`
7. `supports EIP-712 signed meta-transactions and rejects signature replay & expiry`
8. `propagates batch recall to both unsplit and already-split units and supports cancelTransfer`
9. `covers batch cancel, delivery status updates, executeTransferBySig, flagProduct, and negative edge guards`

## 2. Solidity Coverage Results

From `npm run contracts:coverage`:

| File | % Statements | % Branch | % Functions | % Lines |
| :--- | :--- | :--- | :--- | :--- |
| `ChainTraceRegistry.sol` | `95.83%` | `58.4%` | `100%` | `89.96%` |
