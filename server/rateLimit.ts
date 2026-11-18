import type { NextFunction, Request, Response } from 'express';
import { protectionConfig } from './config.ts';
import type { ProtectionConfig } from './config.ts';

export type RateLimitErrorCode =
  | 'USER_RATE_LIMIT'
  | 'IP_RATE_LIMIT'
  | 'USER_DAILY_LIMIT'
  | 'IP_DAILY_LIMIT'
  | 'FOLLOWUP_RATE_LIMIT';

export interface RateLimitDecision {
  allowed: boolean;
  code?: RateLimitErrorCode;
  message?: string;
  retryAfterSeconds?: number;
}

export interface RateLimitStoreOptions {
  config?: ProtectionConfig;
  maxEntries?: number;
  windowMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
}

export interface RateLimitStoreStats {
  slidingWindowEntries: number;
  dailyCounterEntries: number;
}

interface DailyCounterEntry {
  utcDay: string;
  count: number;
  updatedAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

export function getUtcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function getSecondsUntilNextUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  const nextMidnightMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((nextMidnightMs - timestampMs) / 1000));
}

/**
 * Safely resolves the client IP using Express's `req.ip` (which only honors
 * `X-Forwarded-For` when Express `trust proxy` is configured), falling back to
 * `req.socket?.remoteAddress`. Never parses arbitrary `X-Forwarded-For` directly.
 */
export function resolveClientIp(req: Request): string {
  const rawIp =
    typeof req.ip === 'string' && req.ip.trim().length > 0
      ? req.ip.trim()
      : typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.trim().length > 0
        ? req.socket.remoteAddress.trim()
        : 'unknown';

  const normalized = rawIp.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return normalized.slice(7);
  }
  return normalized;
}

export class InMemoryRateLimitStore {
  private readonly config: ProtectionConfig;
  private readonly maxEntries: number;
  private readonly windowMs: number;
  private readonly pruneIntervalMs: number;
  private readonly nowFn: () => number;

  private readonly slidingWindows = new Map<string, number[]>();
  private readonly dailyCounters = new Map<string, DailyCounterEntry>();
  private lastPruneAt = 0;

  constructor(options: RateLimitStoreOptions = {}) {
    this.config = options.config ?? protectionConfig;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.windowMs = Math.max(1000, options.windowMs ?? DEFAULT_WINDOW_MS);
    this.pruneIntervalMs = Math.max(1000, options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS);
    this.nowFn = options.now ?? (() => Date.now());
  }

  getStats(): RateLimitStoreStats {
    return {
      slidingWindowEntries: this.slidingWindows.size,
      dailyCounterEntries: this.dailyCounters.size,
    };
  }

  pruneExpired(now = this.nowFn()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.slidingWindows) {
      let firstValidIdx = 0;
      while (firstValidIdx < timestamps.length && timestamps[firstValidIdx] <= cutoff) {
        firstValidIdx++;
      }
      if (firstValidIdx >= timestamps.length) {
        this.slidingWindows.delete(key);
      } else if (firstValidIdx > 0) {
        this.slidingWindows.set(key, timestamps.slice(firstValidIdx));
      }
    }

    const currentDay = getUtcDayKey(now);
    for (const [key, entry] of this.dailyCounters) {
      if (entry.utcDay !== currentDay) {
        this.dailyCounters.delete(key);
      }
    }

    this.lastPruneAt = now;
  }

  private maybePrune(now: number): void {
    if (
      now - this.lastPruneAt >= this.pruneIntervalMs ||
      this.slidingWindows.size >= this.maxEntries ||
      this.dailyCounters.size >= this.maxEntries
    ) {
      this.pruneExpired(now);
    }
  }

  private getActiveWindowTimestamps(key: string, now: number): number[] {
    const existing = this.slidingWindows.get(key);
    if (!existing || existing.length === 0) {
      return [];
    }

    const cutoff = now - this.windowMs;
    let firstValidIdx = 0;
    while (firstValidIdx < existing.length && existing[firstValidIdx] <= cutoff) {
      firstValidIdx++;
    }

    if (firstValidIdx >= existing.length) {
      this.slidingWindows.delete(key);
      return [];
    }

    if (firstValidIdx > 0) {
      const active = existing.slice(firstValidIdx);
      this.slidingWindows.set(key, active);
      return active;
    }

    return existing;
  }

  private recordWindowHit(key: string, now: number, activeTimestamps: number[]): void {
    const nextTimestamps = [...activeTimestamps, now];
    if (this.slidingWindows.has(key)) {
      // Refresh LRU insertion order
      this.slidingWindows.delete(key);
    } else {
      while (this.slidingWindows.size >= this.maxEntries) {
        const oldestKey = this.slidingWindows.keys().next().value;
        if (oldestKey === undefined) break;
        this.slidingWindows.delete(oldestKey);
      }
    }
    this.slidingWindows.set(key, nextTimestamps);
  }

  private getActiveDailyCount(key: string, currentDay: string): number {
    const entry = this.dailyCounters.get(key);
    if (!entry) return 0;
    if (entry.utcDay !== currentDay) {
      this.dailyCounters.delete(key);
      return 0;
    }
    return entry.count;
  }

  private recordDailyHit(key: string, currentDay: string, now: number, currentCount: number): void {
    if (this.dailyCounters.has(key)) {
      // Refresh LRU insertion order
      this.dailyCounters.delete(key);
    } else {
      while (this.dailyCounters.size >= this.maxEntries) {
        const oldestKey = this.dailyCounters.keys().next().value;
        if (oldestKey === undefined) break;
        this.dailyCounters.delete(oldestKey);
      }
    }
    this.dailyCounters.set(key, {
      utcDay: currentDay,
      count: currentCount + 1,
      updatedAt: now,
    });
  }

  private computeWindowRetryAfterSeconds(activeTimestamps: number[], now: number): number {
    if (activeTimestamps.length === 0) return 1;
    const oldestExpiryMs = activeTimestamps[0] + this.windowMs;
    return Math.max(1, Math.ceil((oldestExpiryMs - now) / 1000));
  }

  /**
   * Atomically evaluates and records all chat rate limits (per-user RPM,
   * per-IP RPM, per-user UTC daily, per-IP UTC daily) without async yields,
   * ensuring concurrent requests cannot corrupt counters or consume unrelated
   * buckets when another limit denies the request.
   */
  consumeChat(uid: string, clientIp: string): RateLimitDecision {
    const now = this.nowFn();
    this.maybePrune(now);

    const userRpmKey = `chat:rpm:uid:${uid}`;
    const ipRpmKey = `chat:rpm:ip:${clientIp}`;
    const userDailyKey = `chat:day:uid:${uid}`;
    const ipDailyKey = `chat:day:ip:${clientIp}`;
    const currentDay = getUtcDayKey(now);

    const userTimestamps = this.getActiveWindowTimestamps(userRpmKey, now);
    if (userTimestamps.length >= this.config.rateLimit.userRpm) {
      const retryAfterSeconds = this.computeWindowRetryAfterSeconds(userTimestamps, now);
      return {
        allowed: false,
        code: 'USER_RATE_LIMIT',
        retryAfterSeconds,
        message: `You are sending messages too quickly. Please wait ${retryAfterSeconds} seconds before trying again.`,
      };
    }

    const ipTimestamps = this.getActiveWindowTimestamps(ipRpmKey, now);
    if (ipTimestamps.length >= this.config.rateLimit.ipRpm) {
      const retryAfterSeconds = this.computeWindowRetryAfterSeconds(ipTimestamps, now);
      return {
        allowed: false,
        code: 'IP_RATE_LIMIT',
        retryAfterSeconds,
        message: `Too many requests from your network right now. Please wait ${retryAfterSeconds} seconds and try again.`,
      };
    }

    const userDailyCount = this.getActiveDailyCount(userDailyKey, currentDay);
    if (userDailyCount >= this.config.rateLimit.userDaily) {
      const retryAfterSeconds = getSecondsUntilNextUtcDay(now);
      return {
        allowed: false,
        code: 'USER_DAILY_LIMIT',
        retryAfterSeconds,
        message:
          'You have reached your daily free chat limit for today. Please try again after UTC midnight.',
      };
    }

    const ipDailyCount = this.getActiveDailyCount(ipDailyKey, currentDay);
    if (ipDailyCount >= this.config.rateLimit.ipDaily) {
      const retryAfterSeconds = getSecondsUntilNextUtcDay(now);
      return {
        allowed: false,
        code: 'IP_DAILY_LIMIT',
        retryAfterSeconds,
        message:
          'Your network has reached the daily free usage limit for today. Please try again after UTC midnight.',
      };
    }

    // Commit all hits together only after every check succeeds
    this.recordWindowHit(userRpmKey, now, userTimestamps);
    this.recordWindowHit(ipRpmKey, now, ipTimestamps);
    this.recordDailyHit(userDailyKey, currentDay, now, userDailyCount);
    this.recordDailyHit(ipDailyKey, currentDay, now, ipDailyCount);

    return { allowed: true };
  }

  /**
   * Atomically evaluates and records the follow-up RPM limit for a verified UID.
   */
  consumeFollowup(uid: string): RateLimitDecision {
    const now = this.nowFn();
    this.maybePrune(now);

    const followupKey = `followup:rpm:uid:${uid}`;
    const timestamps = this.getActiveWindowTimestamps(followupKey, now);

    if (timestamps.length >= this.config.rateLimit.followupRpm) {
      const retryAfterSeconds = this.computeWindowRetryAfterSeconds(timestamps, now);
      return {
        allowed: false,
        code: 'FOLLOWUP_RATE_LIMIT',
        retryAfterSeconds,
        message: `Too many follow-up requests. Please wait ${retryAfterSeconds} seconds before trying again.`,
      };
    }

    this.recordWindowHit(followupKey, now, timestamps);
    return { allowed: true };
  }
}

export const rateLimitStore = new InMemoryRateLimitStore();

function sendRateLimitResponse(res: Response, decision: RateLimitDecision): void {
  const retryAfter = Math.max(1, decision.retryAfterSeconds ?? 1);
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({
    error: decision.message ?? 'Too many requests. Please wait a moment and try again.',
    code: decision.code,
    retryAfterSeconds: retryAfter,
  });
}

export function createChatRateLimitMiddleware(
  store: InMemoryRateLimitStore = rateLimitStore
) {
  return function chatRateLimit(
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

    const clientIp = resolveClientIp(req);
    const decision = store.consumeChat(uid, clientIp);
    if (!decision.allowed) {
      sendRateLimitResponse(res, decision);
      return;
    }

    next();
  };
}

export function createFollowupRateLimitMiddleware(
  store: InMemoryRateLimitStore = rateLimitStore
) {
  return function followupRateLimit(
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

    const decision = store.consumeFollowup(uid);
    if (!decision.allowed) {
      sendRateLimitResponse(res, decision);
      return;
    }

    next();
  };
}

export const chatRateLimitMiddleware = createChatRateLimitMiddleware(rateLimitStore);
export const followupRateLimitMiddleware = createFollowupRateLimitMiddleware(rateLimitStore);
