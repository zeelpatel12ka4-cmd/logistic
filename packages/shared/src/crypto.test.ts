import {
  buildMerkleTree,
  canonicalizeJson,
  computeBatchId,
  computeClaimSecretHash,
  computeLeaf,
  computeMetadataHash,
  computeProductId,
  verifyMerkleProof,
} from './crypto';
import { QrPayloadSchema } from './schemas';

describe('@chaintrace/shared crypto & Merkle SDK', () => {
  const manufacturer = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

  it('produces identical canonical JSON regardless of key order', () => {
    const a = canonicalizeJson({ b: 2, a: 1, nested: { z: true, y: 'ok' } });
    const b = canonicalizeJson({ nested: { y: 'ok', z: true }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(computeMetadataHash({ b: 2, a: 1 })).toBe(computeMetadataHash({ a: 1, b: 2 }));
  });

  it('builds and verifies Merkle proofs for odd, single, and large 5,000-unit batches', () => {
    const batchId = computeBatchId(manufacturer, 'BATCH-TEST-5K');

    // Single leaf tree
    const singleLeaf = computeLeaf({
      batchId,
      productId: computeProductId(manufacturer, batchId, 'SN-1'),
      serialNumber: 'SN-1',
      metadataHash: computeMetadataHash({ sku: 'X1' }),
      claimSecretHash: computeClaimSecretHash('sec-1'),
    });
    const singleTree = buildMerkleTree([singleLeaf]);
    expect(verifyMerkleProof(singleTree.root, singleLeaf, singleTree.getProof(0))).toBe(true);

    // 5,000 leaves tree
    const metaHash = computeMetadataHash({ sku: 'ELEC-PRO', batch: '5K' });
    const leaves: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const serial = `SN-${i}`;
      const productId = computeProductId(manufacturer, batchId, serial);
      const claimSecretHash = computeClaimSecretHash(`sec-${i}`);
      leaves.push(
        computeLeaf({
          batchId,
          productId,
          serialNumber: serial,
          metadataHash: metaHash,
          claimSecretHash,
        }),
      );
    }

    const tree = buildMerkleTree(leaves);
    expect(tree.leafCount).toBe(5000);

    for (const idx of [0, 1, 2499, 4998, 4999]) {
      const proof = tree.getProof(idx);
      expect(verifyMerkleProof(tree.root, leaves[idx], proof)).toBe(true);
      expect(verifyMerkleProof(tree.root, leaves[(idx + 1) % 5000], proof)).toBe(false);
    }
  });

  it('validates QR payloads strictly with Zod', () => {
    const batchId = computeBatchId(manufacturer, 'B1');
    const productId = computeProductId(manufacturer, batchId, 'SN-1');
    const valid = QrPayloadSchema.safeParse({
      v: 1,
      chainId: 31337,
      contractAddress: manufacturer,
      batchId,
      productId,
      serialNumber: 'SN-1',
      metadataHash: computeMetadataHash({ sku: 'A' }),
      claimSecretHash: computeClaimSecretHash('secret'),
      claimSecret: 'secret',
      merkleProof: [],
    });
    expect(valid.success).toBe(true);

    const invalid = QrPayloadSchema.safeParse({
      v: 2,
      batchId: 'not-hex',
    });
    expect(invalid.success).toBe(false);
  });
});
