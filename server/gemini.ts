import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { Content, GenerateContentConfig, Part } from '@google/genai';
import mammoth from 'mammoth';

export interface IncomingHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  attachmentSummary?: string;
}

export interface UploadedFileInput {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface GroundingSource {
  title: string;
  uri: string;
  domain: string;
}

export interface GroundingResult {
  enabled: boolean;
  used: boolean;
  searchQueries: string[];
  sources: GroundingSource[];
}

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
const INLINE_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_TEXT_DOC_CHARS = 180_000;

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const ALLOWED_MIME_TYPES = new Set<string>(Object.values(EXTENSION_MIME_MAP));

const SYSTEM_INSTRUCTION = `You are VEYRIC AI, a warm, natural, intelligent conversational assistant.

Personality & Conversation Style:
- Speak like a thoughtful, friendly, approachable human conversation partner — never robotic, stiff, or like a search engine.
- Respond naturally and warmly to greetings (such as "Hello", "Hi", "Mingalabar", "မင်္ဂလာပါ"), casual conversation, and follow-up questions.
  - For example, if someone greets you in Burmese ("မင်္ဂလာပါ VEYRIC AI"), respond warmly and naturally in Burmese, such as welcoming them and asking what they'd like to talk about today.
- Match the user's language naturally: support both Burmese (Myanmar) and English fluently, and adapt to casual or professional tone as appropriate.
- Maintain context smoothly across multi-turn conversations without repeating boilerplate disclaimers.
- Format longer explanations cleanly with Markdown and language-tagged code blocks when helpful, while keeping short conversational replies concise and natural.
- When the user asks you to write or craft an AI image prompt, AI video prompt, text-to-video prompt, image-to-video prompt, or other reusable generation prompt, keep any brief intro or usage tips separate and place the complete, ready-to-copy prompt text cleanly inside a fenced \`\`\`prompt code block (never actually claim to generate the image or video yourself).

Honesty & Tools:
- When analyzing attached images, videos, or documents, base your analysis strictly on the actual file content provided. If something in a file is unclear or unreadable, say so honestly.
- Never fabricate URLs, citations, statistics, or claim to have inspected a file if it was not provided or failed to process.
- When Google Search grounding provides verified web information, synthesize it clearly and accurately.
- Never generate or claim to generate images or videos; your role is natural conversation, reasoning, web research when needed, and analyzing user-provided files.`;

const PURE_GREETING_OR_CASUAL_REGEX =
  /^(?:hi+|hello+|hey+|yo+|hola|mingalabar|mingalarba|good\s+(?:morning|afternoon|evening|night)|how\s+are\s+you(?:\s+doing)?|what'?s\s+up|thanks?(?:\s+you)?|thank\s+you(?:\s+so\s+much)?|ok(?:ay)?|sure|cool|great|nice|bye|goodbye|see\s+you|မင်္ဂလာပါ|ဟယ်လို|နေကောင်းလား|နေကောင်းပါသလား|ကျေးဇူး(?:ပါ|တင်ပါတယ်)?|ဟုတ်ကဲ့|ကောင်းပါပြီ|ဘိုင့်ဘိုင်)(?:\s+(?:veyric(?:\s+ai)?|ai|friend|there))?[\s!?.။၊]*$/i;

const EXPLICIT_SEARCH_INTENT_REGEX =
  /(?:\b(?:search(?:\s+the)?\s+(?:web|internet|online)|google\s+(?:this|for|it)?|look\s+up|find\s+(?:me\s+)?(?:sources?|links?|websites?|articles?)|with\s+(?:sources?|links?|citations?)|website\s+links?|latest\s+(?:news|updates?|developments?|version|release|price|score)|current(?:ly)?\s+(?:price|weather|status|president|ceo|time|news|rate|exchange)|real[- ]?time|today'?s\s+(?:news|weather|price|score)|this\s+(?:week|month|year)'?s\s+news|breaking\s+news|live\s+score|who\s+won\s+(?:the\s+)?(?:last|latest|202\d)|what\s+happened\s+(?:today|yesterday|recently))\b|ရှာပေး|အင်တာနက်(?:မှာ|ပေါ်)|ဝက်ဘ်ဆိုက်|လင့်ခ်|နောက်ဆုံးရ(?:သတင်း)?|ယနေ့(?:သတင်း|ရာသီဥတု|ဈေးနှုန်း)|လက်ရှိ(?:ဈေး|အခြေအနေ|သတင်း))/i;

export function decideShouldUseWebSearch(
  message: string,
  explicitWebSearch: boolean
): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  // Never trigger web search for pure greetings, thanks, or simple casual pleasantries
  if (PURE_GREETING_OR_CASUAL_REGEX.test(trimmed)) {
    return false;
  }

  // Always search if the user explicitly asks to search the web, wants links/sources, or asks for real-time/current info
  if (EXPLICIT_SEARCH_INTENT_REGEX.test(trimmed)) {
    return true;
  }

  // Otherwise, only use web search when the user explicitly toggled Web Search on
  return explicitWebSearch;
}

const COMPLEX_TASK_REGEX =
  /(?:```|\b(?:code|typescript|javascript|python|react|sql|api|bug|debug|error|exception|stack\s*trace|refactor|optimize|algorithm|architecture|schema|database|compare|comparison|trade-?offs?|step[- ]by[- ]step|analyze|analysis|essay|report|business\s*plan|strategy)\b)/i;

export function decideThinkingLevel(params: {
  message: string;
  hasFiles: boolean;
  shouldSearch: boolean;
}): ThinkingLevel {
  if (params.hasFiles || params.shouldSearch) {
    return ThinkingLevel.MEDIUM;
  }

  const trimmed = params.message.trim();
  if (!trimmed || PURE_GREETING_OR_CASUAL_REGEX.test(trimmed)) {
    return ThinkingLevel.LOW;
  }

  if (
    trimmed.length >= 220 ||
    trimmed.includes('\n') ||
    COMPLEX_TASK_REGEX.test(trimmed)
  ) {
    return ThinkingLevel.MEDIUM;
  }

  return ThinkingLevel.LOW;
}

let cachedClient: GoogleGenAI | null = null;
let cachedKey: string | undefined;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      503,
      'Gemini API key is not configured on the server. Please configure GEMINI_API_KEY in Settings > Secrets.'
    );
  }
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedKey = apiKey;
  }
  return cachedClient;
}

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function resolveSupportedMimeType(file: UploadedFileInput): string {
  const ext = path.extname(file.originalname).toLowerCase();
  const extMime = EXTENSION_MIME_MAP[ext];
  const declaredMime = (file.mimetype || '').toLowerCase().split(';')[0].trim();

  if (extMime) {
    return extMime;
  }
  if (ALLOWED_MIME_TYPES.has(declaredMime)) {
    return declaredMime;
  }

  throw new HttpError(
    400,
    `Unsupported file format for "${file.originalname}". Supported formats: JPG, JPEG, PNG, WEBP, MP4, MOV, WEBM, PDF, TXT, MD, CSV, JSON, and DOCX.`
  );
}

async function waitForGeminiFileActive(ai: GoogleGenAI, name: string): Promise<{ uri: string; mimeType?: string }> {
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const fileInfo = await ai.files.get({ name });
    if (fileInfo.state === 'ACTIVE' && fileInfo.uri) {
      return { uri: fileInfo.uri, mimeType: fileInfo.mimeType };
    }
    if (fileInfo.state === 'FAILED') {
      throw new HttpError(422, 'The uploaded media file could not be processed by Gemini.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new HttpError(504, 'Timed out while processing the uploaded media file.');
}

async function fileToGeminiPart(
  ai: GoogleGenAI,
  file: UploadedFileInput,
  uploadedFileNamesToCleanup: string[]
): Promise<Part> {
  if (file.size <= 0) {
    throw new HttpError(400, `Attached file "${file.originalname}" is empty.`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new HttpError(
      400,
      `Attached file "${file.originalname}" exceeds the 25 MB limit.`
    );
  }

  const mimeType = resolveSupportedMimeType(file);

  // DOCX extraction via mammoth
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await mammoth.extractRawText({ path: file.path });
      const text = result.value.trim();
      if (!text) {
        throw new HttpError(
          422,
          `No readable text could be extracted from "${file.originalname}".`
        );
      }
      const trimmed =
        text.length > MAX_TEXT_DOC_CHARS
          ? `${text.slice(0, MAX_TEXT_DOC_CHARS)}\n\n[Document truncated due to length]`
          : text;
      return {
        text: `[Attached DOCX Document: ${file.originalname}]\n${trimmed}`,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        422,
        `Failed to parse DOCX file "${file.originalname}". The file may be corrupted or encrypted.`
      );
    }
  }

  // Plain text / Markdown / CSV / JSON documents
  if (
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/json'
  ) {
    try {
      const raw = await fs.readFile(file.path, 'utf8');
      const cleaned = raw.replace(/\u0000/g, '').trim();
      if (!cleaned) {
        throw new HttpError(422, `Document "${file.originalname}" contains no readable text.`);
      }
      const trimmed =
        cleaned.length > MAX_TEXT_DOC_CHARS
          ? `${cleaned.slice(0, MAX_TEXT_DOC_CHARS)}\n\n[Document truncated due to length]`
          : cleaned;
      return {
        text: `[Attached Document: ${file.originalname} (${mimeType})]\n${trimmed}`,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, `Failed to read text document "${file.originalname}".`);
    }
  }

  // Images and small PDFs via inlineData for low-latency processing
  if ((mimeType.startsWith('image/') || mimeType === 'application/pdf') && file.size < INLINE_THRESHOLD_BYTES) {
    const buffer = await fs.readFile(file.path);
    return {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    };
  }

  // Videos and larger PDFs via Gemini Files API
  const uploaded = await ai.files.upload({
    file: file.path,
    config: {
      mimeType,
      displayName: file.originalname,
    },
  });

  if (!uploaded.name) {
    throw new HttpError(502, `Failed to register "${file.originalname}" with Gemini File API.`);
  }
  uploadedFileNamesToCleanup.push(uploaded.name);

  let uri = uploaded.uri;
  let resolvedMime = uploaded.mimeType || mimeType;

  if (uploaded.state === 'PROCESSING' || !uri) {
    const active = await waitForGeminiFileActive(ai, uploaded.name);
    uri = active.uri;
    resolvedMime = active.mimeType || resolvedMime;
  } else if (uploaded.state === 'FAILED') {
    throw new HttpError(422, `Processing failed for "${file.originalname}".`);
  }

  return {
    fileData: {
      fileUri: uri,
      mimeType: resolvedMime,
    },
  };
}

function buildConversationContents(
  history: IncomingHistoryMessage[],
  currentMessage: string,
  fileParts: Part[]
): Content[] {
  const contents: Content[] = [];

  for (const turn of history.slice(-28)) {
    const textPieces: string[] = [];
    if (turn.attachmentSummary) {
      textPieces.push(`[Previously attached files: ${turn.attachmentSummary}]`);
    }
    if (turn.content && turn.content.trim()) {
      textPieces.push(turn.content.trim());
    }
    const combined = textPieces.join('\n\n').trim();
    if (!combined) continue;

    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: combined }],
    });
  }

  const currentParts: Part[] = [...fileParts];
  const trimmedPrompt = currentMessage.trim();
  if (trimmedPrompt) {
    currentParts.push({ text: trimmedPrompt });
  } else if (fileParts.length > 0) {
    currentParts.push({
      text: 'Please analyze the attached file(s) and summarize the key details clearly.',
    });
  }

  contents.push({
    role: 'user',
    parts: currentParts,
  });

  return contents;
}

function extractDomain(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return uri;
  }
}

function sanitizeLogString(value: string): string {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  let cleaned = value;
  if (apiKey) {
    cleaned = cleaned.replaceAll(apiKey, '[REDACTED]');
  }
  return cleaned
    .replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[REDACTED]');
}

export interface GeminiErrorDiagnostics {
  context: string;
  httpStatus?: number;
  errorStatus?: string;
  quotaMetrics: Array<{ quotaMetric?: string; quotaId?: string }>;
  retryDelay?: string;
  summary: string;
}

export function extractGeminiErrorDiagnostics(
  context: string,
  error: unknown
): GeminiErrorDiagnostics {
  const httpStatus =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : error instanceof HttpError
        ? error.statusCode
        : undefined;

  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  let errorStatus: string | undefined;
  let retryDelay: string | undefined;
  const quotaMetrics: Array<{ quotaMetric?: string; quotaId?: string }> = [];
  let summary = rawMessage;

  const jsonStart = rawMessage.indexOf('{');
  const jsonEnd = rawMessage.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(rawMessage.slice(jsonStart, jsonEnd + 1)) as {
        error?: {
          code?: number;
          status?: string;
          message?: string;
          details?: Array<Record<string, unknown>>;
        };
      };
      const apiErr = parsed?.error;
      if (apiErr) {
        if (typeof apiErr.status === 'string') {
          errorStatus = apiErr.status;
        }
        if (typeof apiErr.message === 'string' && apiErr.message.trim()) {
          summary = apiErr.message.trim();
        }
        if (Array.isArray(apiErr.details)) {
          for (const detail of apiErr.details) {
            const typeStr = typeof detail['@type'] === 'string' ? detail['@type'] : '';
            if (typeStr.includes('QuotaFailure') && Array.isArray(detail.violations)) {
              for (const v of detail.violations as Array<Record<string, unknown>>) {
                quotaMetrics.push({
                  ...(typeof v.quotaMetric === 'string' ? { quotaMetric: v.quotaMetric } : {}),
                  ...(typeof v.quotaId === 'string' ? { quotaId: v.quotaId } : {}),
                });
              }
            }
            if (typeStr.includes('RetryInfo') && typeof detail.retryDelay === 'string') {
              retryDelay = detail.retryDelay;
            }
          }
        }
      }
    } catch {
      // Keep plain message summary if embedded JSON cannot be parsed
    }
  }

  return {
    context,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(errorStatus ? { errorStatus } : {}),
    quotaMetrics,
    ...(retryDelay ? { retryDelay } : {}),
    summary: sanitizeLogString(summary).slice(0, 320),
  };
}

export function logSanitizedGeminiError(context: string, error: unknown): void {
  if (error instanceof HttpError && error.statusCode === 499) {
    return;
  }
  const diagnostics = extractGeminiErrorDiagnostics(context, error);
  console.error('[VEYRIC Gemini API Error]', JSON.stringify(diagnostics));
}

function isRetryableTransientError(err: unknown): boolean {
  const status =
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined;
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();

  // Never automatically retry rate-limit or quota-exhausted responses
  if (
    status === 429 ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota')
  ) {
    return false;
  }

  if (status === 503 || lower.includes('503') || lower.includes('unavailable')) {
    return true;
  }

  return (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  );
}

export function formatGeminiError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, message: error.message };
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const lower = rawMessage.toLowerCase();

  if (lower.includes('api_key_invalid') || lower.includes('api key not valid') || lower.includes('permission_denied') || lower.includes('403')) {
    return {
      statusCode: 403,
      message: 'The server Gemini API key is invalid or lacks permission. Please verify GEMINI_API_KEY in Settings > Secrets.',
    };
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return {
      statusCode: 429,
      message: 'Rate limit or quota reached for Gemini API. Please wait a moment and try again.',
    };
  }
  if (lower.includes('not_found') || lower.includes('404')) {
    return {
      statusCode: 502,
      message: 'The configured Gemini model could not be reached. Please try again.',
    };
  }
  if (lower.includes('400') || lower.includes('invalid_argument')) {
    return {
      statusCode: 400,
      message: 'The request or uploaded file format could not be processed by Gemini. Please verify your files and prompt.',
    };
  }

  return {
    statusCode: 500,
    message: rawMessage || 'An unexpected error occurred while generating the AI response.',
  };
}

export async function streamGeminiChat(params: {
  history: IncomingHistoryMessage[];
  message: string;
  webSearch: boolean;
  files: UploadedFileInput[];
  signal?: AbortSignal;
  onStatus: (phase: 'processing_files' | 'searching' | 'generating') => void;
  onDelta: (text: string) => void;
}): Promise<GroundingResult> {
  const ai = getGeminiClient();
  const uploadedFileNamesToCleanup: string[] = [];

  try {
    const fileParts: Part[] = [];
    if (params.files.length > 0) {
      params.onStatus('processing_files');
      for (const file of params.files) {
        if (params.signal?.aborted) {
          throw new HttpError(499, 'Request cancelled.');
        }
        const part = await fileToGeminiPart(ai, file, uploadedFileNamesToCleanup);
        fileParts.push(part);
      }
    }

    const shouldSearch = decideShouldUseWebSearch(params.message, params.webSearch);

    if (shouldSearch) {
      params.onStatus('searching');
    } else {
      params.onStatus('generating');
    }

    const contents = buildConversationContents(params.history, params.message, fileParts);
    const thinkingLevel = decideThinkingLevel({
      message: params.message,
      hasFiles: params.files.length > 0,
      shouldSearch,
    });

    const config: GenerateContentConfig = {
      systemInstruction: SYSTEM_INSTRUCTION,
      thinkingConfig: { thinkingLevel },
      ...(shouldSearch ? { tools: [{ googleSearch: {} }] } : {}),
    };

    let stream;
    try {
      stream = await ai.models.generateContentStream({
        model: 'gemini-4-hydrogen',
        contents,
        config,
      });
    } catch (firstErr) {
      if (!isRetryableTransientError(firstErr) || params.signal?.aborted) {
        throw firstErr;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (params.signal?.aborted) {
        throw new HttpError(499, 'Request cancelled.');
      }
      stream = await ai.models.generateContentStream({
        model: 'gemini-4-hydrogen',
        contents,
        config,
      });
    }

    const querySet = new Set<string>();
    const sourceMap = new Map<string, GroundingSource>();
    let sentGeneratingStatus = !shouldSearch;

    for await (const chunk of stream) {
      if (params.signal?.aborted) {
        break;
      }

      const chunkText = chunk.text;
      if (chunkText) {
        if (!sentGeneratingStatus) {
          params.onStatus('generating');
          sentGeneratingStatus = true;
        }
        params.onDelta(chunkText);
      }

      const metadata = chunk.candidates?.[0]?.groundingMetadata;
      if (metadata) {
        if (Array.isArray(metadata.webSearchQueries)) {
          for (const q of metadata.webSearchQueries) {
            if (typeof q === 'string' && q.trim()) {
              querySet.add(q.trim());
            }
          }
        }
        if (Array.isArray(metadata.groundingChunks)) {
          for (const gChunk of metadata.groundingChunks) {
            const web = gChunk.web;
            if (web?.uri && /^https?:\/\//i.test(web.uri)) {
              if (!sourceMap.has(web.uri)) {
                const domain = extractDomain(web.uri);
                sourceMap.set(web.uri, {
                  title: (web.title || domain).trim(),
                  uri: web.uri,
                  domain,
                });
              }
            }
          }
        }
      }
    }

    const sources = Array.from(sourceMap.values());
    const searchQueries = Array.from(querySet);

    return {
      enabled: shouldSearch,
      used: sources.length > 0 || searchQueries.length > 0,
      searchQueries,
      sources,
    };
  } finally {
    // Best-effort cleanup of temporary Gemini Files API uploads
    for (const fileName of uploadedFileNamesToCleanup) {
      ai.files.delete({ name: fileName }).catch(() => {
        // Ignore cleanup failures
      });
    }
  }
}

export async function generateFollowUpSuggestions(params: {
  userMessage: string;
  assistantMessage: string;
  contentType?: string | null;
}): Promise<string[]> {
  const userText = params.userMessage.trim();
  const assistantText = params.assistantMessage.trim();

  // Never show follow-up suggestions after simple greetings, casual acknowledgements, or very short replies
  if (!assistantText || assistantText.length < 70) {
    return [];
  }
  if (userText && PURE_GREETING_OR_CASUAL_REGEX.test(userText)) {
    return [];
  }

  try {
    const ai = getGeminiClient();
    const snippet = assistantText.slice(0, 900);
    const contentHint = params.contentType
      ? `The assistant just produced a structured deliverable of type "${params.contentType}". Suggest practical editing, refinement, or variation actions tailored to that deliverable.`
      : 'Suggest 2 to 4 natural, directly relevant next questions or refinement actions based on the conversation.';

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `User message:\n${userText || '(Attached file analysis)'}\n\nAssistant response excerpt:\n${snippet}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction: `Generate 2 to 4 concise follow-up questions or next-step action prompts that the user can click to continue this exact conversation.
Rules:
- Match the primary language of the conversation (use Burmese if the conversation is in Burmese, English if in English).
- Keep each suggestion short and natural (under 10 words, no numbering, no quotes).
- ${contentHint}
- Never include generic filler unrelated to the conversation.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 to 4 concise, contextual follow-up prompts.',
            },
          },
          required: ['suggestions'],
        },
      },
    });

    const raw = (response.text ?? '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) return [];

    return parsed.suggestions
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 4);
  } catch (err) {
    logSanitizedGeminiError('/api/followups', err);
    return [];
  }
}
