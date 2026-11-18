import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import type { StorageEngine } from 'multer';
import { protectionConfig } from './config.ts';
import type { ProtectionConfig } from './config.ts';
import type { UploadedFileInput } from './gemini.ts';

export const UPLOAD_DIR = path.join(os.tmpdir(), 'veyric-ai-uploads');
export const UPLOAD_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const UPLOAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MULTIPART_FIELDS_LIMIT = 10;

// Overhead allowance for multipart boundaries + form fields when checking Content-Length pre-Multer
const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 1024 * 1024; // 1 MiB

export type UploadErrorCode =
  | 'TOTAL_UPLOAD_TOO_LARGE'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'FIELD_TOO_LARGE'
  | 'TOO_MANY_FIELDS'
  | 'TOO_MANY_PARTS'
  | 'INVALID_UPLOAD';

export class UploadLimitError extends Error {
  statusCode: number;
  code: UploadErrorCode;

  constructor(statusCode: number, code: UploadErrorCode, message: string) {
    super(message);
    this.name = 'UploadLimitError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface RequestUploadState {
  dir: string;
  totalBytes: number;
  dirCreated: boolean;
  routeEntered: boolean;
  cleaned: boolean;
}

const requestUploadStates = new WeakMap<Request, RequestUploadState>();

export class UploadDirectoryManager {
  readonly baseDir: string;
  private readonly ttlMs: number;
  private readonly activeDirs = new Set<string>();
  private cleanupInFlight = false;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseDir: string = UPLOAD_DIR, ttlMs: number = UPLOAD_TTL_MS) {
    this.baseDir = baseDir;
    this.ttlMs = ttlMs;
  }

  async ensureBaseDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  isDirectoryActive(dirPath: string): boolean {
    return this.activeDirs.has(dirPath);
  }

  getActiveCount(): number {
    return this.activeDirs.size;
  }

  initRequestState(req: Request, res: Response): RequestUploadState {
    const existing = requestUploadStates.get(req);
    if (existing) return existing;

    const dir = path.join(this.baseDir, `req-${crypto.randomUUID()}`);
    const state: RequestUploadState = {
      dir,
      totalBytes: 0,
      dirCreated: false,
      routeEntered: false,
      cleaned: false,
    };
    requestUploadStates.set(req, state);
    this.activeDirs.add(dir);

    // If client disconnects before route handler starts (e.g., mid-Multer abort),
    // clean up the isolated temp directory safely.
    if (typeof res.on === 'function') {
      res.on('close', () => {
        if (!state.routeEntered) {
          void this.cleanupRequest(req);
        }
      });
    }

    return state;
  }

  markRouteEntered(req: Request): void {
    const state = requestUploadStates.get(req);
    if (state) {
      state.routeEntered = true;
    }
  }

  async ensureRequestDir(state: RequestUploadState): Promise<string> {
    if (!state.dirCreated) {
      await fs.mkdir(state.dir, { recursive: true });
      state.dirCreated = true;
    }
    return state.dir;
  }

  async cleanupRequest(req: Request): Promise<void> {
    const state = requestUploadStates.get(req);
    if (!state || state.cleaned) return;
    state.cleaned = true;

    try {
      if (state.dirCreated) {
        await fs.rm(state.dir, { recursive: true, force: true });
      }
    } catch {
      // Never crash the server on temp cleanup failure
    } finally {
      this.activeDirs.delete(state.dir);
    }
  }

  async runStartupCleanup(): Promise<number> {
    return this.sweepStaleEntries({ removeAllInactive: true });
  }

  async sweepStaleEntries(options: {
    now?: number;
    removeAllInactive?: boolean;
  } = {}): Promise<number> {
    if (this.cleanupInFlight) {
      return 0;
    }
    this.cleanupInFlight = true;
    let removedCount = 0;

    try {
      const now = options.now ?? Date.now();
      let entries: string[];
      try {
        entries = await fs.readdir(this.baseDir);
      } catch {
        return 0;
      }

      for (const entryName of entries) {
        const entryPath = path.join(this.baseDir, entryName);
        if (this.activeDirs.has(entryPath)) {
          continue;
        }

        try {
          if (!options.removeAllInactive) {
            const stats = await fs.stat(entryPath);
            if (now - stats.mtimeMs < this.ttlMs) {
              continue;
            }
          }
          await fs.rm(entryPath, { recursive: true, force: true });
          removedCount += 1;
        } catch {
          // Ignore individual filesystem errors so one bad entry cannot abort sweep
        }
      }
    } finally {
      this.cleanupInFlight = false;
    }

    return removedCount;
  }

  startPeriodicCleanup(intervalMs: number = UPLOAD_CLEANUP_INTERVAL_MS): void {
    if (this.periodicTimer) return;
    this.periodicTimer = setInterval(() => {
      void this.sweepStaleEntries();
    }, intervalMs);
    if (typeof this.periodicTimer.unref === 'function') {
      this.periodicTimer.unref();
    }
  }

  stopPeriodicCleanup(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }
}

export const uploadDirectoryManager = new UploadDirectoryManager(UPLOAD_DIR, UPLOAD_TTL_MS);

function createRequestScopedStorage(
  manager: UploadDirectoryManager,
  config: ProtectionConfig
): StorageEngine {
  return {
    _handleFile(req, file, cb) {
      const res = req.res;
      const state =
        requestUploadStates.get(req) ??
        (res ? manager.initRequestState(req, res) : null);

      if (!state) {
        cb(new UploadLimitError(400, 'INVALID_UPLOAD', 'Unable to initialize upload storage.'));
        return;
      }

      manager
        .ensureRequestDir(state)
        .then((dir) => {
          const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
          const safeName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}${safeExt}`;
          const filePath = path.join(dir, safeName);
          const outStream = fsSync.createWriteStream(filePath);

          let fileBytes = 0;
          let finished = false;
          let aborted = false;

          const failAndCleanup = (err: Error) => {
            if (finished) return;
            finished = true;
            aborted = true;
            file.stream.unpipe(outStream);
            outStream.destroy();
            fs.unlink(filePath)
              .catch(() => {})
              .finally(() => {
                cb(err);
              });
          };

          const onAbort = () => {
            failAndCleanup(
              new UploadLimitError(400, 'INVALID_UPLOAD', 'Upload was aborted before completion.')
            );
          };

          req.once('aborted', onAbort);

          file.stream.on('data', (chunk: Buffer) => {
            if (finished || aborted) return;
            fileBytes += chunk.length;
            state.totalBytes += chunk.length;

            if (state.totalBytes > config.uploads.maxTotalUploadBytes) {
              const maxTotalMb = Math.round(config.uploads.maxTotalUploadBytes / (1024 * 1024));
              failAndCleanup(
                new UploadLimitError(
                  413,
                  'TOTAL_UPLOAD_TOO_LARGE',
                  `Total attached file size exceeds the ${maxTotalMb} MB limit per message.`
                )
              );
            }
          });

          file.stream.on('error', (err) => {
            req.off('aborted', onAbort);
            failAndCleanup(err);
          });

          outStream.on('error', (err) => {
            req.off('aborted', onAbort);
            failAndCleanup(err);
          });

          outStream.on('finish', () => {
            req.off('aborted', onAbort);
            if (finished || aborted) return;
            finished = true;
            cb(null, {
              destination: dir,
              filename: safeName,
              path: filePath,
              size: fileBytes,
            });
          });

          file.stream.pipe(outStream);
        })
        .catch((err) => {
          cb(err instanceof Error ? err : new Error('Failed to prepare upload directory.'));
        });
    },

    _removeFile(_req, file, cb) {
      if (!file?.path) {
        cb(null);
        return;
      }
      fs.unlink(file.path)
        .then(() => cb(null))
        .catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'ENOENT') {
            cb(null);
          } else {
            cb(err);
          }
        });
    },
  };
}

export function createPreMulterUploadGuard(
  manager: UploadDirectoryManager = uploadDirectoryManager,
  config: ProtectionConfig = protectionConfig
) {
  return function preMulterUploadGuard(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const rawContentLength = req.headers['content-length'];
    if (typeof rawContentLength === 'string' && rawContentLength.trim().length > 0) {
      const contentLength = Number(rawContentLength);
      const maxRequestBytes =
        config.uploads.maxTotalUploadBytes +
        Math.max(config.uploads.maxFormFieldBytes * 4, MULTIPART_OVERHEAD_ALLOWANCE_BYTES);

      if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
        const maxTotalMb = Math.round(config.uploads.maxTotalUploadBytes / (1024 * 1024));
        res.status(413).json({
          error: `Total upload size exceeds the ${maxTotalMb} MB limit per message.`,
          code: 'TOTAL_UPLOAD_TOO_LARGE',
        });
        return;
      }
    }

    manager.initRequestState(req, res);
    next();
  };
}

export function createProtectedMulter(
  manager: UploadDirectoryManager = uploadDirectoryManager,
  config: ProtectionConfig = protectionConfig
) {
  const storage = createRequestScopedStorage(manager, config);
  const upload = multer({
    storage,
    limits: {
      fileSize: config.uploads.maxFileSizeBytes,
      files: config.uploads.maxFilesPerRequest,
      fieldSize: config.uploads.maxFormFieldBytes,
      fields: MULTIPART_FIELDS_LIMIT,
      parts: config.uploads.maxFilesPerRequest + MULTIPART_FIELDS_LIMIT,
    },
  });

  const arrayMiddleware = upload.array('files', config.uploads.maxFilesPerRequest);

  return function protectedUploadMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    arrayMiddleware(req, res, (err?: unknown) => {
      if (err) {
        void manager.cleanupRequest(req).finally(() => next(err));
        return;
      }

      // Post-Multer aggregate check defense-in-depth
      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
      if (totalSize > config.uploads.maxTotalUploadBytes) {
        const maxTotalMb = Math.round(config.uploads.maxTotalUploadBytes / (1024 * 1024));
        void manager.cleanupRequest(req).finally(() =>
          next(
            new UploadLimitError(
              413,
              'TOTAL_UPLOAD_TOO_LARGE',
              `Total attached file size exceeds the ${maxTotalMb} MB limit per message.`
            )
          )
        );
        return;
      }

      next();
    });
  };
}

export function createUploadErrorHandler(
  manager: UploadDirectoryManager = uploadDirectoryManager,
  config: ProtectionConfig = protectionConfig
) {
  return function uploadErrorHandler(
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    if (err instanceof UploadLimitError) {
      void manager.cleanupRequest(req);
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
      });
      return;
    }

    if (err instanceof multer.MulterError) {
      void manager.cleanupRequest(req);
      const maxFileMb = Math.round(config.uploads.maxFileSizeBytes / (1024 * 1024));
      const maxFiles = config.uploads.maxFilesPerRequest;

      switch (err.code) {
        case 'LIMIT_FILE_SIZE':
          res.status(400).json({
            error: `Each attached file must be ${maxFileMb} MB or smaller.`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        case 'LIMIT_FILE_COUNT':
          res.status(400).json({
            error: `You can attach up to ${maxFiles} files per message.`,
            code: 'TOO_MANY_FILES',
          });
          return;
        case 'LIMIT_FIELD_VALUE':
          res.status(400).json({
            error: 'A submitted form field exceeds the maximum allowed size.',
            code: 'FIELD_TOO_LARGE',
          });
          return;
        case 'LIMIT_FIELD_COUNT':
          res.status(400).json({
            error: 'Too many form fields were submitted.',
            code: 'TOO_MANY_FIELDS',
          });
          return;
        case 'LIMIT_PART_COUNT':
          res.status(400).json({
            error: 'Too many multipart parts were submitted.',
            code: 'TOO_MANY_PARTS',
          });
          return;
        default:
          res.status(400).json({
            error: 'Invalid file upload request.',
            code: 'INVALID_UPLOAD',
          });
          return;
      }
    }

    if (
      req.aborted ||
      (err instanceof Error && err.message === 'Request aborted')
    ) {
      void manager.cleanupRequest(req);
      if (!res.headersSent) {
        res.status(499).end();
      }
      return;
    }

    next(err);
  };
}

export function toUploadedFileInputs(files: unknown): UploadedFileInput[] {
  if (!Array.isArray(files)) return [];
  return files.map((f: Express.Multer.File) => ({
    path: f.path,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
  }));
}
