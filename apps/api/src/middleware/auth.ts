import { NextFunction, Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { SupplyChainRole } from '@chaintrace/shared';
import { HttpError } from './errorHandler';

export interface AuthSession {
  walletAddress: string;
  roles: SupplyChainRole[];
  chainId: number;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthSession;
}

export const AUTH_COOKIE_NAME = 'chaintrace_session';

export function signSessionToken(session: AuthSession, secret: string): string {
  return jwt.sign(session, secret, { expiresIn: '12h' });
}

export function verifySessionToken(token: string, secret: string): AuthSession {
  return jwt.verify(token, secret) as AuthSession;
}

export function extractSession(req: AuthenticatedRequest, jwtSecret: string): AuthSession | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME] as string | undefined;
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const token = bearerToken || cookieToken;
  if (!token) return null;

  try {
    return verifySessionToken(token, jwtSecret);
  } catch {
    return null;
  }
}

export function requireAuth(jwtSecret: string) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    const session = extractSession(req, jwtSecret);
    if (!session) {
      next(new HttpError(401, 'UNAUTHORIZED', 'Valid SIWE authentication session is required'));
      return;
    }
    req.auth = session;
    next();
  };
}

export function requireLiveRoles(
  resolveRoles: (walletAddress: string) => Promise<SupplyChainRole[]>,
  ...allowed: SupplyChainRole[]
) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.auth) {
      next(new HttpError(401, 'UNAUTHORIZED', 'Authentication required'));
      return;
    }
    try {
      const liveRoles = await resolveRoles(req.auth.walletAddress);
      const hasAccess = liveRoles.some((r) => allowed.includes(r) || r === 'ADMIN');
      if (!hasAccess) {
        next(
          new HttpError(
            403,
            'FORBIDDEN',
            `Requires active on-chain role: ${allowed.join(', ')}`,
          ),
        );
        return;
      }
      req.auth.roles = liveRoles;
      next();
    } catch (err) {
      next(err);
    }
  };
}
