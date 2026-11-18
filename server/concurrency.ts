import type { NextFunction, Request, Response } from 'express';
import { protectionConfig } from './config.ts';
import type { ProtectionConfig } from './config.ts';

export type ConcurrencyErrorCode = 'USER_CONCURRENCY_LIMIT' | 'SERVER_BUSY';

export type ConcurrencyAcquireResult =
  | {
      acquired: true;
      releaseOnce: () => void;
    }
  | {
      acquired: false;
      statusCode: 429 | 503;
      code: ConcurrencyErrorCode;
      retryAfterSeconds: number;
      message: string;
    };

export interface ConcurrencyManagerStats {
  globalActive: number;
  activeUserCount: number;
  maxPerUser: number;
  maxGeminiGlobal: number;
}

const DEFAULT_RETRY_AFTER_SECONDS = 5;

export class InMemoryConcurrencyManager {
  private readonly config: ProtectionConfig;
  private globalActive = 0;
  private readonly activeByUser = new Map<string, number>();

  constructor(config: ProtectionConfig = protectionConfig) {
    this.config = config;
  }

  getStats(): ConcurrencyManagerStats {
    return {
      globalActive: this.globalActive,
      activeUserCount: this.activeByUser.size,
      maxPerUser: this.config.concurrency.maxPerUser,
      maxGeminiGlobal: this.config.concurrency.maxGeminiGlobal,
    };
  }

  getUserActiveCount(uid: string): number {
    return this.activeByUser.get(uid) ?? 0;
  }

  /**
   * Synchronously and atomically checks per-user and per-instance concurrency
   * caps and acquires a slot. Returns an idempotent `releaseOnce()` callback.
   */
  acquireSlot(uid: string): ConcurrencyAcquireResult {
    const currentUserActive = this.activeByUser.get(uid) ?? 0;

    if (currentUserActive >= this.config.concurrency.maxPerUser) {
      return {
        acquired: false,
        statusCode: 429,
        code: 'USER_CONCURRENCY_LIMIT',
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        message:
          'You already have active chat requests in progress. Please wait for one to finish before starting another.',
      };
    }

    if (this.globalActive >= this.config.concurrency.maxGeminiGlobal) {
      return {
        acquired: false,
        statusCode: 503,
        code: 'SERVER_BUSY',
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        message:
          'VEYRIC AI is currently busy handling other requests. Please wait a moment and try again.',
      };
    }

    this.globalActive += 1;
    this.activeByUser.set(uid, currentUserActive + 1);

    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;

      this.globalActive = Math.max(0, this.globalActive - 1);

      const current = this.activeByUser.get(uid) ?? 0;
      if (current <= 1) {
        this.activeByUser.delete(uid);
      } else {
        this.activeByUser.set(uid, current - 1);
      }
    };

    return {
      acquired: true,
      releaseOnce,
    };
  }
}

export const concurrencyManager = new InMemoryConcurrencyManager();

/**
 * Safely binds an idempotent `releaseOnce` callback to `res.on('close')`,
 * `res.on('finish')`, and `res.locals.releaseConcurrencySlot` for route `try/finally`.
 */
export function bindConcurrencyRelease(res: Response, releaseOnce: () => void): void {
  if (!res.locals) {
    res.locals = {};
  }
  res.locals.releaseConcurrencySlot = releaseOnce;

  if (typeof res.on === 'function') {
    res.on('finish', releaseOnce);
    res.on('close', releaseOnce);
  }
}

export function createChatConcurrencyMiddleware(
  manager: InMemoryConcurrencyManager = concurrencyManager
) {
  return function chatConcurrencyGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const uid = req.firebaseUser?.uid;
    if (!uid) {
      res.status(401).json({
        error: 'Authentication required. Please sign in to continue.',
      });
      return;
    }

    const result = manager.acquireSlot(uid);
    if (!result.acquired) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(result.statusCode).json({
        error: result.message,
        code: result.code,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    bindConcurrencyRelease(res, result.releaseOnce);
    next();
  };
}

export const chatConcurrencyMiddleware = createChatConcurrencyMiddleware(concurrencyManager);
