import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { NextFunction, Request, Response } from 'express';
import { protectionConfig } from './config.ts';
import type { ProtectionConfig } from './config.ts';

const FIREBASE_PROJECT_ID = 'veyric-ai';
export const STAGING_ACCESS_DENIED_CODE = 'STAGING_ACCESS_DENIED';

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      firebaseUser?: VerifiedFirebaseUser;
    }
  }
}

const adminApp = getApps().length
  ? getApp()
  : initializeApp({ projectId: FIREBASE_PROJECT_ID });

const adminAuth = getAuth(adminApp);

export async function verifyFirebaseIdToken(
  token: string
): Promise<VerifiedFirebaseUser> {
  const decoded = await adminAuth.verifyIdToken(token);
  if (!decoded?.uid) {
    throw new Error('Token payload missing uid.');
  }
  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified,
  };
}

export async function requireFirebaseAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const rawHeader = req.headers.authorization;
  const authHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!authHeader || typeof authHeader !== 'string') {
    res.status(401).json({
      error: 'Authentication required. Please sign in to continue.',
    });
    return;
  }

  const match = authHeader.trim().match(/^Bearer\s+(\S+)$/i);
  const idToken = match?.[1];
  if (!idToken) {
    res.status(401).json({
      error: 'Malformed authorization header. Please sign in again.',
    });
    return;
  }

  try {
    const verifiedUser = await verifyFirebaseIdToken(idToken);
    req.firebaseUser = verifiedUser;
    next();
  } catch {
    res.status(401).json({
      error: 'Your session has expired or is invalid. Please sign in again.',
    });
  }
}

/**
 * Enforces an explicit Firebase UID allowlist only when private staging mode is
 * active. Fails closed (HTTP 403) when active with an empty or missing list,
 * and leaves production/non-staging environments unchanged.
 */
export function createStagingAccessMiddleware(
  config: ProtectionConfig = protectionConfig
) {
  const allowedUids = new Set(config.staging.allowedUids);

  return function requireStagingTesterAccess(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (!config.staging.enabled) {
      next();
      return;
    }

    const uid = req.firebaseUser?.uid;
    if (!uid) {
      res.status(401).json({
        error: 'Authentication required. Please sign in to continue.',
      });
      return;
    }

    if (allowedUids.size === 0 || !allowedUids.has(uid)) {
      res.status(403).json({
        error:
          'Access denied. This private staging environment is restricted to authorized testers.',
        code: STAGING_ACCESS_DENIED_CODE,
      });
      return;
    }

    next();
  };
}

export const stagingAccessMiddleware = createStagingAccessMiddleware(protectionConfig);
