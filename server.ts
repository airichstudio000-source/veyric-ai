import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import path from 'node:path';
import { requireFirebaseAuth, stagingAccessMiddleware } from './server/auth.ts';
import { protectionConfig } from './server/config.ts';
import { chatConcurrencyMiddleware } from './server/concurrency.ts';
import {
  chatRateLimitMiddleware,
  followupRateLimitMiddleware,
} from './server/rateLimit.ts';
import {
  formatGeminiError,
  generateFollowUpSuggestions,
  HttpError,
  logSanitizedGeminiError,
  streamGeminiChat,
} from './server/gemini.ts';
import {
  createPreMulterUploadGuard,
  createProtectedMulter,
  createUploadErrorHandler,
  toUploadedFileInputs,
  UPLOAD_CLEANUP_INTERVAL_MS,
  uploadDirectoryManager,
} from './server/uploads.ts';
import {
  PayloadValidationError,
  validateChatPayload,
  validateFollowupPayload,
} from './server/validation.ts';

const PORT = Number(process.env.PORT || 3000);

await uploadDirectoryManager.ensureBaseDir();
await uploadDirectoryManager.runStartupCleanup();
uploadDirectoryManager.startPeriodicCleanup(UPLOAD_CLEANUP_INTERVAL_MS);

const preMulterUploadGuard = createPreMulterUploadGuard(uploadDirectoryManager, protectionConfig);
const protectedUpload = createProtectedMulter(uploadDirectoryManager, protectionConfig);
const uploadErrorHandler = createUploadErrorHandler(uploadDirectoryManager, protectionConfig);

const SHUTDOWN_TIMEOUT_MS = 9000;
let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let httpServer: Server | null = null;
let viteServer: { close: () => Promise<void> } | null = null;

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', protectionConfig.trustProxyHops);

app.use((_req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    res.status(503).json({
      error: 'Server is shutting down. Please retry shortly.',
    });
    return;
  }
  next();
});

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
  });
});

function cleanupFilesOnEarlyResponse(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      void uploadDirectoryManager.cleanupRequest(req);
    }
  });
  next();
}

function attachRequestAbortController(req: Request, res: Response): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const abortController = new AbortController();

  const triggerAbort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };

  const onResClose = () => {
    if (!res.writableEnded) {
      triggerAbort();
    }
  };

  const onReqAborted = () => {
    triggerAbort();
  };

  if (res.destroyed || req.aborted || Boolean(res.socket?.destroyed)) {
    triggerAbort();
  } else {
    res.on('close', onResClose);
    req.on('aborted', onReqAborted);
  }

  return {
    signal: abortController.signal,
    cleanup: () => {
      res.off('close', onResClose);
      req.off('aborted', onReqAborted);
    },
  };
}

app.post(
  '/api/chat',
  requireFirebaseAuth,
  stagingAccessMiddleware,
  chatRateLimitMiddleware,
  preMulterUploadGuard,
  protectedUpload,
  cleanupFilesOnEarlyResponse,
  chatConcurrencyMiddleware,
  async (req: Request, res: Response) => {
    uploadDirectoryManager.markRouteEntered(req);
    const uploadedFiles = toUploadedFileInputs(req.files);
    const releaseConcurrency =
      typeof res.locals?.releaseConcurrencySlot === 'function'
        ? (res.locals.releaseConcurrencySlot as () => void)
        : undefined;

    const { signal: requestAbortSignal, cleanup: cleanupAbortListeners } =
      attachRequestAbortController(req, res);

    let sseStarted = false;

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded && !res.destroyed && !requestAbortSignal.aborted) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      if (requestAbortSignal.aborted) {
        return;
      }

      const { message: rawMessage, webSearch, history } = validateChatPayload({
        body: req.body as Record<string, unknown> | undefined,
        fileCount: uploadedFiles.length,
        config: protectionConfig,
      });

      if (requestAbortSignal.aborted) {
        return;
      }

      // Begin SSE stream
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      sseStarted = true;

      const grounding = await streamGeminiChat({
        history,
        message: rawMessage,
        webSearch,
        files: uploadedFiles,
        signal: requestAbortSignal,
        onStatus: (phase) => {
          sendEvent({ type: 'status', phase });
        },
        onDelta: (text) => {
          sendEvent({ type: 'delta', text });
        },
      });

      if (!requestAbortSignal.aborted) {
        sendEvent({ type: 'done', grounding });
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch (error) {
      if (requestAbortSignal.aborted || res.destroyed || (error instanceof HttpError && error.statusCode === 499)) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      } else if (error instanceof PayloadValidationError && !sseStarted) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
      } else {
        logSanitizedGeminiError('/api/chat', error);
        const formatted = formatGeminiError(error);
        if (!sseStarted) {
          res.status(formatted.statusCode).json({ error: formatted.message });
        } else {
          sendEvent({
            type: 'error',
            statusCode: formatted.statusCode,
            error: formatted.message,
          });
          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
        }
      }
    } finally {
      cleanupAbortListeners();
      releaseConcurrency?.();
      await uploadDirectoryManager.cleanupRequest(req);
    }
  }
);

app.post(
  '/api/followups',
  requireFirebaseAuth,
  stagingAccessMiddleware,
  followupRateLimitMiddleware,
  async (req: Request, res: Response) => {
    const { signal: requestAbortSignal, cleanup: cleanupAbortListeners } =
      attachRequestAbortController(req, res);

    try {
      if (requestAbortSignal.aborted) {
        return;
      }

      const { userMessage, assistantMessage, contentType } = validateFollowupPayload({
        body: req.body as Record<string, unknown> | undefined,
        config: protectionConfig,
      });

      if (requestAbortSignal.aborted) {
        return;
      }

      if (!assistantMessage.trim()) {
        res.json({ suggestions: [] });
        return;
      }

      const suggestions = await generateFollowUpSuggestions({
        userMessage,
        assistantMessage,
        contentType,
        signal: requestAbortSignal,
      });

      if (requestAbortSignal.aborted || res.destroyed || res.writableEnded) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      res.json({ suggestions });
    } catch (error) {
      if (requestAbortSignal.aborted || res.destroyed || res.writableEnded) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      if (error instanceof PayloadValidationError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      if (error instanceof HttpError && error.statusCode === 504) {
        logSanitizedGeminiError('/api/followups', error);
        const formatted = formatGeminiError(error);
        res.status(formatted.statusCode).json({ error: formatted.message });
        return;
      }
      res.json({ suggestions: [] });
    } finally {
      cleanupAbortListeners();
    }
  }
);

// Handle Multer & upload limit errors cleanly
app.use(uploadErrorHandler);

async function startServer() {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const isProdOrStaging = nodeEnv === 'production' || nodeEnv === 'staging';

  if (!isProdOrStaging) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  if (isShuttingDown) {
    return;
  }

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`VEYRIC AI server running on http://0.0.0.0:${PORT}`);
  });
}

function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  isShuttingDown = true;
  console.log(`[VEYRIC AI] Received ${signal}. Starting graceful shutdown...`);
  uploadDirectoryManager.stopPeriodicCleanup();

  shutdownPromise = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
      process.exit(exitCode);
    };

    const forceTimer = setTimeout(() => {
      console.warn(
        `[VEYRIC AI] Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms. Closing remaining connections.`
      );
      httpServer?.closeAllConnections?.();
      finish(0);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref?.();

    const closeExtras = () =>
      Promise.resolve(viteServer?.close()).catch(() => {
        // Ignore dev server close errors during shutdown
      });

    if (!httpServer) {
      void closeExtras().finally(() => finish(0));
      return;
    }

    httpServer.close((err) => {
      if (err) {
        console.error('[VEYRIC AI] Error closing HTTP server:', err.message);
        void closeExtras().finally(() => finish(1));
        return;
      }
      console.log('[VEYRIC AI] HTTP server closed cleanly.');
      void closeExtras().finally(() => finish(0));
    });

    // Drop idle keep-alive sockets immediately while allowing active requests/SSE streams to drain
    httpServer.closeIdleConnections?.();
  });

  return shutdownPromise;
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

startServer().catch((err) => {
  console.error('[VEYRIC AI] Failed to start server:', err);
  uploadDirectoryManager.stopPeriodicCleanup();
  process.exit(1);
});
