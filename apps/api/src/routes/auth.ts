import { Router } from 'express';
import { z } from 'zod';
import { EvmAddressSchema, SiweVerifySchema } from '@chaintrace/shared';
import { AuthService } from '../services/authService';
import { AUTH_COOKIE_NAME, AuthenticatedRequest, requireAuth } from '../middleware/auth';

const NonceRequestSchema = z.object({
  walletAddress: EvmAddressSchema,
});

export function createAuthRouter(authService: AuthService, jwtSecret: string): Router {
  const router = Router();

  router.post('/nonce', async (req, res, next) => {
    try {
      const { walletAddress } = NonceRequestSchema.parse(req.body);
      const data = await authService.issueNonce(walletAddress);
      res.status(200).json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post('/verify', async (req, res, next) => {
    try {
      const { message, signature } = SiweVerifySchema.parse(req.body);
      const result = await authService.verifySiweAndCreateSession(message, signature);
      res.cookie(AUTH_COOKIE_NAME, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 12 * 60 * 60 * 1000,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth(jwtSecret), async (req: AuthenticatedRequest, res, next) => {
    try {
      const liveRoles = await authService.resolveOnChainRoles(req.auth!.walletAddress);
      res.status(200).json({
        walletAddress: req.auth!.walletAddress,
        roles: liveRoles,
        chainId: req.auth!.chainId,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(AUTH_COOKIE_NAME);
    res.status(200).json({ ok: true });
  });

  router.get('/roles/:address', async (req, res, next) => {
    try {
      const addr = EvmAddressSchema.parse(req.params.address);
      const roles = await authService.resolveOnChainRoles(addr);
      res.status(200).json({ address: addr, roles });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
