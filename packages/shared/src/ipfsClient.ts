import { canonicalizeJson, computeMetadataHash } from './crypto';

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
  ): Promise<{ data: unknown; verified: boolean; canonicalJson: string }> {
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
      if (!res.ok) {
        throw new Error(`IPFS cat failed with HTTP ${res.status}`);
      }
      const rawText = await res.text();
      const parsed = JSON.parse(rawText);
      const canonicalJson = canonicalizeJson(parsed);
      const actualHash = computeMetadataHash(canonicalJson);
      const verified = expectedMetadataHash
        ? actualHash.toLowerCase() === expectedMetadataHash.toLowerCase()
        : true;
      return { data: parsed, verified, canonicalJson };
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
