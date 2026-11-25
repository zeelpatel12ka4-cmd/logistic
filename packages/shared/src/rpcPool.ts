import { ethers } from 'ethers';

export interface RpcEndpointState {
  url: string;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  totalRequests: number;
  totalFailures: number;
}

export class AllRpcEndpointsUnavailableError extends Error {
  constructor(public readonly endpoints: RpcEndpointState[]) {
    super('All configured blockchain RPC endpoints are offline or circuit-broken');
    this.name = 'AllRpcEndpointsUnavailableError';
  }
}

export interface RpcPoolOptions {
  urls: string[];
  chainId?: number;
  requestTimeoutMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export class RpcFailoverPool {
  private readonly states: RpcEndpointState[];
  private readonly providers: Map<string, ethers.JsonRpcProvider> = new Map();
  private readonly requestTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly chainId?: number;

  constructor(options: RpcPoolOptions) {
    const cleanUrls = options.urls.map((u) => u.trim()).filter(Boolean);
    if (cleanUrls.length === 0) {
      throw new Error('RpcFailoverPool requires at least one RPC URL');
    }
    this.chainId = options.chainId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.failureThreshold = options.failureThreshold ?? 2;
    this.cooldownMs = options.cooldownMs ?? 15000;

    this.states = cleanUrls.map((url) => ({
      url,
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastError: null,
      totalRequests: 0,
      totalFailures: 0,
    }));
  }

  private getProvider(url: string): ethers.JsonRpcProvider {
    let provider = this.providers.get(url);
    if (!provider) {
      const fetchReq = new ethers.FetchRequest(url);
      fetchReq.timeout = this.requestTimeoutMs;
      provider = new ethers.JsonRpcProvider(
        fetchReq,
        this.chainId ? ethers.Network.from(this.chainId) : undefined,
        {
          staticNetwork: this.chainId ? true : undefined,
          cacheTimeout: -1,
        },
      );
      this.providers.set(url, provider);
    }
    return provider;
  }

  public getHealthSnapshot(): RpcEndpointState[] {
    return this.states.map((s) => ({ ...s }));
  }

  public async execute<T>(fn: (provider: ethers.JsonRpcProvider, url: string) => Promise<T>): Promise<T> {
    const now = Date.now();
    const candidates = this.states.filter((state) => {
      if (state.circuitState === 'CLOSED') return true;
      if (state.circuitState === 'OPEN' && state.lastFailureAt !== null) {
        if (now - state.lastFailureAt >= this.cooldownMs) {
          state.circuitState = 'HALF_OPEN';
          return true;
        }
      }
      return state.circuitState === 'HALF_OPEN';
    });

    const ordered = candidates.length > 0 ? candidates : this.states;
    let lastErr: unknown = null;

    for (const state of ordered) {
      state.totalRequests += 1;
      const provider = this.getProvider(state.url);
      try {
        const result = await withTimeout(
          fn(provider, state.url),
          this.requestTimeoutMs,
          `RPC timeout (${state.url})`,
        );
        state.circuitState = 'CLOSED';
        state.consecutiveFailures = 0;
        state.lastSuccessAt = Date.now();
        state.lastError = null;
        return result;
      } catch (err) {
        if (isEvmApplicationError(err)) {
          throw err;
        }
        lastErr = err;
        state.consecutiveFailures += 1;
        state.totalFailures += 1;
        state.lastFailureAt = Date.now();
        state.lastError = err instanceof Error ? err.message : String(err);
        if (state.consecutiveFailures >= this.failureThreshold) {
          state.circuitState = 'OPEN';
        }
      }
    }

    const error = new AllRpcEndpointsUnavailableError(this.getHealthSnapshot());
    if (lastErr instanceof Error) {
      error.message = `${error.message}: ${lastErr.message}`;
    }
    throw error;
  }

  public async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      provider.destroy();
    }
    this.providers.clear();
  }
}

function isEvmApplicationError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    code === 'CALL_EXCEPTION' ||
    code === 'INVALID_ARGUMENT' ||
    code === 'UNPREDICTABLE_GAS_LIMIT' ||
    code === 'NONCE_EXPIRED' ||
    code === 'INSUFFICIENT_FUNDS'
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
