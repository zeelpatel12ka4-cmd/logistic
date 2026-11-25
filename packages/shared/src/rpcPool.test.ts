import { RpcFailoverPool, AllRpcEndpointsUnavailableError } from './rpcPool';

describe('RpcFailoverPool & Circuit Breaker', () => {
  it('fails over to secondary RPC when primary goes offline and opens circuit', async () => {
    const pool = new RpcFailoverPool({
      urls: ['http://127.0.0.1:19991', 'http://127.0.0.1:19992'],
      chainId: 31337,
      requestTimeoutMs: 500,
      failureThreshold: 1,
      cooldownMs: 30_000,
    });

    const result = await pool.execute(async (_provider, url) => {
      if (url.includes('19991')) {
        throw new Error('ECONNREFUSED primary');
      }
      return { ok: true, servedBy: url };
    });

    expect(result.servedBy).toBe('http://127.0.0.1:19992');
    const snapshot = pool.getHealthSnapshot();
    expect(snapshot[0].circuitState).toBe('OPEN');
    expect(snapshot[1].circuitState).toBe('CLOSED');
    await pool.destroy();
  });

  it('throws AllRpcEndpointsUnavailableError when every RPC endpoint fails', async () => {
    const pool = new RpcFailoverPool({
      urls: ['http://127.0.0.1:19993'],
      requestTimeoutMs: 300,
      failureThreshold: 1,
    });

    await expect(
      pool.execute(async () => {
        throw new Error('network unreachable');
      }),
    ).rejects.toBeInstanceOf(AllRpcEndpointsUnavailableError);
    await pool.destroy();
  });

  it('does not trip circuit breaker on Solidity CALL_EXCEPTION reverts', async () => {
    const pool = new RpcFailoverPool({
      urls: ['http://127.0.0.1:8545'],
      failureThreshold: 1,
    });

    const revertErr = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      data: '0xe2517d3f',
    });

    await expect(
      pool.execute(async () => {
        throw revertErr;
      }),
    ).rejects.toMatchObject({ code: 'CALL_EXCEPTION', data: '0xe2517d3f' });

    const snap = pool.getHealthSnapshot();
    expect(snap[0].circuitState).toBe('CLOSED');
    expect(snap[0].consecutiveFailures).toBe(0);
    await pool.destroy();
  });
});
