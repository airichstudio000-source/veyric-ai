import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
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

const app = express();

app.set('trust proxy', protectionConfig.trustProxyHops);

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

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  let sseStarted = false;

  const sendEvent = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  try {
    const { message: rawMessage, webSearch, history } = validateChatPayload({
      body: req.body as Record<string, unknown> | undefined,
      fileCount: uploadedFiles.length,
      config: protectionConfig,
    });

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
      signal: abortController.signal,
      onStatus: (phase) => {
        sendEvent({ type: 'status', phase });
      },
      onDelta: (text) => {
        sendEvent({ type: 'delta', text });
      },
    });

    sendEvent({ type: 'done', grounding });
    res.end();
  } catch (error) {
    if (error instanceof PayloadValidationError && !sseStarted) {
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
        res.end();
      }
    }
  } finally {
    releaseConcurrency?.();
    await uploadDirectoryManager.cleanupRequest(req);
  }
});

app.post(
  '/api/followups',
  requireFirebaseAuth,
  stagingAccessMiddleware,
  followupRateLimitMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { userMessage, assistantMessage, contentType } = validateFollowupPayload({
        body: req.body as Record<string, unknown> | undefined,
        config: protectionConfig,
      });

      if (!assistantMessage.trim()) {
        res.json({ suggestions: [] });
        return;
      }

      const suggestions = await generateFollowUpSuggestions({
        userMessage,
        assistantMessage,
        contentType,
      });
      res.json({ suggestions });
    } catch (error) {
      if (error instanceof PayloadValidationError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.json({ suggestions: [] });
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
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VEYRIC AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
