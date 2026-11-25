import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import { SiweMessage } from 'siwe';
import {
  CHAIN_TRACE_REGISTRY_ABI,
  ROLE_HASHES,
  RpcFailoverPool,
  SupplyChainRole,
} from '@chaintrace/shared';
import { HttpError } from '../middleware/errorHandler';
import { signSessionToken } from '../middleware/auth';

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly rpcPool: RpcFailoverPool,
    private readonly contractAddress: string,
    private readonly jwtSecret: string,
    private readonly chainId: number,
  ) {}

  public async issueNonce(walletAddress: string): Promise<{ nonce: string; expiresAt: string }> {
    const checksummed = ethers.getAddress(walletAddress);
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await this.pool.query(
      `INSERT INTO auth_nonces (nonce, wallet_address, expires_at)
       VALUES ($1, $2, $3)`,
      [nonce, checksummed, expiresAt],
    );

    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  public async resolveOnChainRoles(walletAddress: string): Promise<SupplyChainRole[]> {
    if (!this.contractAddress) return [];
    const checksummed = ethers.getAddress(walletAddress);

    try {
      return await this.rpcPool.execute(async (provider) => {
        const contract = new ethers.Contract(
          this.contractAddress,
          CHAIN_TRACE_REGISTRY_ABI,
          provider,
        );
        const [isAdmin, isMfg, isDist, isWh, isRet, isAud] = await Promise.all([
          contract.hasRole(ROLE_HASHES.DEFAULT_ADMIN_ROLE, checksummed) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.MANUFACTURER_ROLE, checksummed) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.DISTRIBUTOR_ROLE, checksummed) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.WAREHOUSE_ROLE, checksummed) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.RETAILER_ROLE, checksummed) as Promise<boolean>,
          contract.hasRole(ROLE_HASHES.AUDITOR_ROLE, checksummed) as Promise<boolean>,
        ]);

        const roles: SupplyChainRole[] = [];
        if (isAdmin) roles.push('ADMIN');
        if (isMfg) roles.push('MANUFACTURER');
        if (isDist) roles.push('DISTRIBUTOR');
        if (isWh) roles.push('WAREHOUSE');
        if (isRet) roles.push('RETAILER');
        if (isAud) roles.push('AUDITOR');
        return roles;
      });
    } catch {
      return [];
    }
  }

  public async verifySiweAndCreateSession(messageStr: string, signature: string) {
    let siweMessage: SiweMessage;
    try {
      siweMessage = new SiweMessage(messageStr);
    } catch (err) {
      throw new HttpError(400, 'INVALID_SIWE_MESSAGE', 'Malformed EIP-4361 SIWE message', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const walletAddress = ethers.getAddress(siweMessage.address);

    // Atomically consume unused non-expired nonce to prevent replay
    const consumeRes = await this.pool.query<{ nonce: string }>(
      `UPDATE auth_nonces
       SET consumed_at = NOW()
       WHERE nonce = $1
         AND LOWER(wallet_address) = LOWER($2)
         AND consumed_at IS NULL
         AND expires_at > NOW()
       RETURNING nonce`,
      [siweMessage.nonce, walletAddress],
    );

    if (!consumeRes.rowCount) {
      throw new HttpError(401, 'INVALID_OR_EXPIRED_NONCE', 'SIWE nonce is invalid, expired, or already used');
    }

    try {
      const verifyResult = await siweMessage.verify({
        signature,
        nonce: siweMessage.nonce,
      });
      if (!verifyResult.success) {
        throw new HttpError(401, 'INVALID_SIGNATURE', 'SIWE signature verification failed');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'INVALID_SIGNATURE', 'SIWE signature verification failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const roles = await this.resolveOnChainRoles(walletAddress);
    const primaryRole = roles[0] || 'CUSTOMER';

    await this.pool.query(
      `INSERT INTO users (wallet_address, role, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (wallet_address)
       DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [walletAddress, primaryRole],
    );

    const token = signSessionToken(
      {
        walletAddress,
        roles,
        chainId: siweMessage.chainId || this.chainId,
      },
      this.jwtSecret,
    );

    return {
      token,
      user: {
        walletAddress,
        roles,
        primaryRole,
        chainId: siweMessage.chainId || this.chainId,
      },
    };
  }
}
