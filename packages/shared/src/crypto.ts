import { ethers } from 'ethers';

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeBatchId(manufacturerAddress: string, batchCode: string): string {
  const checksummed = ethers.getAddress(manufacturerAddress);
  return ethers.keccak256(abiCoder.encode(['address', 'string'], [checksummed, batchCode]));
}

export function computeProductId(
  manufacturerAddress: string,
  batchId: string,
  serialNumber: string,
): string {
  const checksummed = ethers.getAddress(manufacturerAddress);
  return ethers.keccak256(
    abiCoder.encode(['address', 'bytes32', 'string'], [checksummed, batchId, serialNumber]),
  );
}

export function computeMetadataHash(metadata: unknown): string {
  const canonical = typeof metadata === 'string' ? metadata : canonicalizeJson(metadata);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

export function computeClaimSecretHash(claimSecret: string): string {
  if (!claimSecret) return ethers.ZeroHash;
  return ethers.keccak256(ethers.toUtf8Bytes(claimSecret));
}

/**
 * Matches ChainTraceRegistry.computeLeaf exactly:
 * keccak256(bytes.concat(keccak256(abi.encode(batchId, productId, serialNumber, metadataHash, claimSecretHash))))
 */
export function computeLeaf(params: {
  batchId: string;
  productId: string;
  serialNumber: string;
  metadataHash: string;
  claimSecretHash: string;
}): string {
  const inner = ethers.keccak256(
    abiCoder.encode(
      ['bytes32', 'bytes32', 'string', 'bytes32', 'bytes32'],
      [
        params.batchId,
        params.productId,
        params.serialNumber,
        params.metadataHash,
        params.claimSecretHash,
      ],
    ),
  );
  return ethers.keccak256(inner);
}

export function hashMerklePair(a: string, b: string): string {
  const [first, second] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [first, second]));
}

export interface MerkleTreeInstance {
  root: string;
  leafCount: number;
  layers: string[][];
  getProof: (index: number) => string[];
}

export function buildMerkleTree(leaves: string[]): MerkleTreeInstance {
  if (leaves.length === 0) {
    throw new Error('Cannot build Merkle tree from empty leaves');
  }
  const layers: string[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next: string[] = new Array(Math.ceil(current.length / 2));
    let outIdx = 0;
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next[outIdx++] = hashMerklePair(current[i], current[i + 1]);
      } else {
        next[outIdx++] = current[i];
      }
    }
    layers.push(next);
  }

  const root = layers[layers.length - 1][0];
  const getProof = (index: number): string[] => {
    if (index < 0 || index >= leaves.length) {
      throw new RangeError(`Leaf index ${index} out of bounds [0, ${leaves.length - 1}]`);
    }
    const proof: string[] = [];
    let cursor = index;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const sibling = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
      if (sibling < layer.length) {
        proof.push(layer[sibling]);
      }
      cursor = Math.floor(cursor / 2);
    }
    return proof;
  };

  return {
    root,
    leafCount: leaves.length,
    layers,
    getProof,
  };
}

export function verifyMerkleProof(root: string, leaf: string, proof: string[]): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashMerklePair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
