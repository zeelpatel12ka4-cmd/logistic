import { canonicalizeJson, computeMetadataHash } from './crypto';

export type IpfsMetadataStatus =
  | 'METADATA_VERIFIED'
  | 'CONTENT_HASH_MISMATCH'
  | 'CID_INVALID'
  | 'IPFS_OFFLINE'
  | 'METADATA_UNAVAILABLE';

export function isValidIpfsCid(cid: string): boolean {
  if (!cid || typeof cid !== 'string') return false;
  // CIDv0 (Qm...) or CIDv1 base32/base58 (bafy.../bafk...)
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid) || /^b[a-z2-7]{50,}$/i.test(cid);
}

export interface IpfsPinResult {
  cid: string;
  metadataHash: string;
  canonicalJson: string;
  pinnedToIpfs: boolean;
}

export class IpfsClient {
  constructor(
    private readonly apiUrl: string,
    private readonly timeoutMs: number = 4000,
  ) {}

  public async pinJson(payload: unknown): Promise<IpfsPinResult> {
    const canonicalJson = canonicalizeJson(payload);
    const metadataHash = computeMetadataHash(canonicalJson);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      const blob = new Blob([canonicalJson], { type: 'application/json' });
      formData.append('file', blob, 'metadata.json');

      const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}/api/v0/add?pin=true&cid-version=1`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`IPFS pin failed with HTTP ${res.status}`);
      }

      const data = (await res.json()) as { Hash?: string };
      if (!data.Hash) {
        throw new Error('IPFS add response missing Hash');
      }

      return {
        cid: data.Hash,
        metadataHash,
        canonicalJson,
        pinnedToIpfs: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async fetchAndVerifyJson(
    cid: string,
    expectedMetadataHash?: string,
  ): Promise<{
    data: unknown;
    verified: boolean;
    status: IpfsMetadataStatus;
    canonicalJson: string | null;
  }> {
    if (!isValidIpfsCid(cid)) {
      return { data: null, verified: false, status: 'CID_INVALID', canonicalJson: null };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(
        `${this.apiUrl.replace(/\/$/, '')}/api/v0/cat?arg=${encodeURIComponent(cid)}`,
        {
          method: 'POST',
          signal: controller.signal,
        },
      );
      if (res.status === 404 || res.status === 500) {
        return { data: null, verified: false, status: 'METADATA_UNAVAILABLE', canonicalJson: null };
      }
      if (!res.ok) {
        return { data: null, verified: false, status: 'IPFS_OFFLINE', canonicalJson: null };
      }
      const rawText = await res.text();
      const parsed = JSON.parse(rawText);
      const canonicalJson = canonicalizeJson(parsed);
      const actualHash = computeMetadataHash(canonicalJson);
      const verified = expectedMetadataHash
        ? actualHash.toLowerCase() === expectedMetadataHash.toLowerCase()
        : true;
      return {
        data: parsed,
        verified,
        status: verified ? 'METADATA_VERIFIED' : 'CONTENT_HASH_MISMATCH',
        canonicalJson,
      };
    } catch {
      return { data: null, verified: false, status: 'IPFS_OFFLINE', canonicalJson: null };
    } finally {
      clearTimeout(timer);
    }
  }

  public async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}/api/v0/id`, {
        method: 'POST',
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
