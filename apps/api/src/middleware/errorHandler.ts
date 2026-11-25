import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AllRpcEndpointsUnavailableError } from '@chaintrace/shared';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: err.flatten(),
      },
    });
    return;
  }

  if (err instanceof AllRpcEndpointsUnavailableError) {
    res.status(503).json({
      error: {
        code: 'RPC_UNAVAILABLE',
        message: err.message,
        details: err.endpoints,
      },
    });
    return;
  }

  const pgErr = err as { code?: string; message?: string };
  if (pgErr?.code === 'ECONNREFUSED' || pgErr?.code === '57P01' || pgErr?.code === '53300') {
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is temporarily unavailable',
      },
    });
    return;
  }

  console.error('[API Unhandled Error]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred',
    },
  });
}
