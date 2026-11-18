import type {
  ChatErrorKind,
  ChatMessage,
  GroundingInfo,
  StreamPhase,
} from '../types/chat';
import { auth } from './firebase';
import { validateOutgoingPayload } from './fileValidation';

export const MAX_HISTORY_TURNS = 28;
export const MAX_HISTORY_TURN_CHARS = 8000;
export const MAX_HISTORY_TOTAL_CHARS = 48000;
export const MAX_ATTACHMENT_SUMMARY_CHARS = 1000;

export const QUOTA_EXHAUSTED_MESSAGE =
  'VEYRIC AI is temporarily unavailable because the shared AI service has reached its usage limit. Please try again later.';

export const AUTH_SESSION_ERROR_MESSAGE =
  'Your session has expired or could not be verified. Please sign in again to continue.';

export const SERVICE_BUSY_ERROR_MESSAGE =
  'VEYRIC AI is temporarily busy. Please wait a moment and try again.';

export const GENERIC_CHAT_ERROR_MESSAGE =
  'Failed to generate a response. Please try again.';

export class ChatApiError extends Error {
  kind: ChatErrorKind;
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: ChatErrorKind,
    statusCode?: number,
    code?: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ChatApiError';
    this.kind = kind;
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function containsSensitiveOrRawPayload(text: string): boolean {
  return (
    /AIza[0-9A-Za-z_-]{16,}/.test(text) ||
    /Bearer\s+[A-Za-z0-9._-]+/i.test(text) ||
    /got status:/i.test(text) ||
    (text.includes('{') && text.includes('"error"')) ||
    /api[_-]?key|gemini_api_key/i.test(text)
  );
}

export function parseRetryAfterSeconds(
  headerValue: string | null,
  bodyValue?: unknown
): number | undefined {
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue) && bodyValue > 0) {
    return Math.max(1, Math.ceil(bodyValue));
  }
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return undefined;
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const diffSeconds = Math.ceil((parsedDate - Date.now()) / 1000);
    return diffSeconds > 0 ? diffSeconds : undefined;
  }

  return undefined;
}

function formatWaitSuffix(retryAfterSeconds?: number): string {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) {
    return 'Please wait a moment before trying again.';
  }
  if (retryAfterSeconds === 1) {
    return 'Please wait 1 second before trying again.';
  }
  return `Please wait ${retryAfterSeconds} seconds before trying again.`;
}

const APP_RATE_LIMIT_FALLBACKS: Record<string, (retryAfter?: number) => string> = {
  USER_RATE_LIMIT: (wait) =>
    `You are sending messages too quickly. ${formatWaitSuffix(wait)}`,
  IP_RATE_LIMIT: (wait) =>
    `Too many requests from your network right now. ${formatWaitSuffix(wait)}`,
  USER_DAILY_LIMIT: () =>
    'You have reached your daily free chat limit for today. Please try again after UTC midnight.',
  IP_DAILY_LIMIT: () =>
    'Your network has reached the daily free usage limit for today. Please try again after UTC midnight.',
  FOLLOWUP_RATE_LIMIT: (wait) =>
    `Too many follow-up suggestion requests right now. ${formatWaitSuffix(wait)}`,
  USER_CONCURRENCY_LIMIT: (wait) =>
    `You already have too many active chat requests running at once. ${formatWaitSuffix(wait)}`,
};

const RETRYABLE_CODE_FALLBACKS: Record<string, (retryAfter?: number) => string> = {
  SERVER_BUSY: (wait) =>
    wait && wait > 0
      ? `VEYRIC AI is temporarily busy handling many requests. Please wait about ${wait} seconds and try again.`
      : SERVICE_BUSY_ERROR_MESSAGE,
  FILE_TOO_LARGE: () => 'One of the attached files exceeds the 25 MB per-file limit.',
  TOO_MANY_FILES: () => 'You can attach up to 5 files per message.',
  TOTAL_UPLOAD_TOO_LARGE: () => 'Total attached files exceed the 40 MB limit per message.',
  FIELD_TOO_LARGE: () => 'Message text or history is too large to submit.',
  TOO_MANY_FIELDS: () => 'Too many form fields were sent in this request.',
  TOO_MANY_PARTS: () => 'This upload has too many parts. Please send fewer items at once.',
  INVALID_UPLOAD: () =>
    'One or more attached files could not be uploaded. Please check file formats and sizes.',
  INVALID_PROMPT: () => 'Prompt must be valid text.',
  PROMPT_TOO_LONG: () => 'Your message is too long. Please keep it within 8,000 characters.',
  EMPTY_REQUEST: () => 'Please enter a message or attach a supported file.',
  INVALID_HISTORY: () => 'Conversation history could not be processed. Please try again.',
  HISTORY_TOO_MANY_TURNS: () =>
    'Conversation history exceeded the turn limit for this request.',
  HISTORY_TURN_TOO_LONG: () =>
    'A message in this conversation exceeded the per-message limit.',
  HISTORY_TOO_LARGE: () =>
    'Conversation history exceeded the total character limit for this request.',
  INVALID_FOLLOWUP_PAYLOAD: () => 'Could not request follow-up suggestions for this message.',
};

const APP_COOLDOWN_TEXT_RE =
  /sending messages too quickly|too many requests from your network|daily free (?:chat|usage) limit|active chat requests|utc midnight/i;

export function classifyChatError(params: {
  statusCode?: number;
  rawMessage?: string;
  code?: string;
  retryAfterSeconds?: number;
}): {
  kind: ChatErrorKind;
  message: string;
  statusCode?: number;
  code?: string;
  retryAfterSeconds?: number;
} {
  const { statusCode, rawMessage = '', code, retryAfterSeconds } = params;
  const trimmed = rawMessage.trim();
  const lower = trimmed.toLowerCase();
  const safeTrimmed = trimmed && !containsSensitiveOrRawPayload(trimmed) ? trimmed : '';

  // 1a. Private staging allowlist rejection (403 STAGING_ACCESS_DENIED) -> non-retryable
  if (code === 'STAGING_ACCESS_DENIED') {
    return {
      kind: 'auth',
      statusCode: 403,
      code,
      message:
        safeTrimmed ||
        'Access denied. This private staging environment is restricted to authorized testers.',
    };
  }

  // 1b. Firebase authentication / session errors (401)
  if (
    statusCode === 401 ||
    lower.includes('session has expired') ||
    lower.includes('authentication required') ||
    lower.includes('malformed authorization') ||
    lower.includes('please sign in')
  ) {
    return {
      kind: 'auth',
      statusCode: 401,
      code,
      message:
        lower.includes('please sign in to continue')
          ? 'Please sign in to continue.'
          : AUTH_SESSION_ERROR_MESSAGE,
    };
  }

  // 2. Application per-user / per-IP rate-limit or concurrency cooldown (429)
  // Kept strictly distinct from upstream Gemini service quota exhaustion messages.
  if (code && code in APP_RATE_LIMIT_FALLBACKS) {
    let message = safeTrimmed || APP_RATE_LIMIT_FALLBACKS[code](retryAfterSeconds);
    if (
      retryAfterSeconds &&
      code !== 'USER_DAILY_LIMIT' &&
      code !== 'IP_DAILY_LIMIT' &&
      safeTrimmed &&
      !/\b\d+\s*seconds?\b|utc midnight/i.test(safeTrimmed)
    ) {
      message = `${safeTrimmed} ${formatWaitSuffix(retryAfterSeconds)}`;
    }
    return {
      kind: 'quota',
      statusCode: 429,
      code,
      retryAfterSeconds,
      message,
    };
  }

  // 2b. Fallback cooldown text detection when a serialized error string lacks a code
  if (APP_COOLDOWN_TEXT_RE.test(lower)) {
    return {
      kind: 'quota',
      statusCode: 429,
      code,
      retryAfterSeconds,
      message: safeTrimmed || APP_RATE_LIMIT_FALLBACKS.USER_RATE_LIMIT(retryAfterSeconds),
    };
  }

  // 3. Backend structured concurrency busy (503) or upload/validation rejections (400/413)
  if (code && code in RETRYABLE_CODE_FALLBACKS) {
    const resolvedStatus =
      statusCode ??
      (code === 'SERVER_BUSY'
        ? 503
        : code === 'TOTAL_UPLOAD_TOO_LARGE'
          ? 413
          : 400);
    let message = safeTrimmed || RETRYABLE_CODE_FALLBACKS[code](retryAfterSeconds);
    if (
      code === 'SERVER_BUSY' &&
      retryAfterSeconds &&
      safeTrimmed &&
      !/\b\d+\s*seconds?\b/i.test(safeTrimmed)
    ) {
      message = `${safeTrimmed} (${formatWaitSuffix(retryAfterSeconds)})`;
    }
    return {
      kind: 'retryable',
      statusCode: resolvedStatus,
      code,
      retryAfterSeconds,
      message,
    };
  }

  // 4. Gemini API upstream quota / rate-limit errors (429 / RESOURCE_EXHAUSTED)
  if (
    statusCode === 429 ||
    /\b429\b/.test(lower) ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      kind: 'quota',
      statusCode: 429,
      code,
      retryAfterSeconds,
      message: QUOTA_EXHAUSTED_MESSAGE,
    };
  }

  // 5. Temporary upstream overload (503) -> manually retryable (never auto-retried)
  if (statusCode === 503 || /\b503\b/.test(lower) || lower.includes('unavailable')) {
    return {
      kind: 'retryable',
      statusCode: 503,
      code,
      retryAfterSeconds,
      message:
        retryAfterSeconds && retryAfterSeconds > 0
          ? RETRYABLE_CODE_FALLBACKS.SERVER_BUSY(retryAfterSeconds)
          : SERVICE_BUSY_ERROR_MESSAGE,
    };
  }

  // 6. Client upload / payload rejections without code
  if (statusCode === 413) {
    return {
      kind: 'retryable',
      statusCode: 413,
      code,
      message: safeTrimmed || RETRYABLE_CODE_FALLBACKS.TOTAL_UPLOAD_TOO_LARGE(),
    };
  }

  // 7. Ordinary / network / server errors -> retryable with sanitized friendly message
  if (
    !safeTrimmed ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 504
  ) {
    return {
      kind: 'retryable',
      statusCode,
      code,
      message: GENERIC_CHAT_ERROR_MESSAGE,
    };
  }

  // Keep clean user-safe validation/file error messages (e.g., 400/422)
  return {
    kind: 'retryable',
    statusCode,
    code,
    message: safeTrimmed,
  };
}

export function toChatApiError(
  error: unknown,
  fallbackStatusCode?: number
): ChatApiError {
  if (error instanceof ChatApiError) {
    return error;
  }
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  const classified = classifyChatError({
    statusCode: fallbackStatusCode,
    rawMessage,
  });
  return new ChatApiError(
    classified.message,
    classified.kind,
    classified.statusCode,
    classified.code,
    classified.retryAfterSeconds
  );
}

export interface HealthResponse {
  ok: boolean;
  apiKeyConfigured: boolean;
}

export async function fetchHealthStatus(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error('Unable to reach server health check.');
  }
  return (await response.json()) as HealthResponse;
}

async function getRequiredIdToken(forceRefresh = false): Promise<string> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new ChatApiError('Please sign in to continue.', 'auth', 401);
  }
  try {
    const token = await currentUser.getIdToken(forceRefresh);
    if (!token) {
      throw new ChatApiError(AUTH_SESSION_ERROR_MESSAGE, 'auth', 401);
    }
    return token;
  } catch (err) {
    if (err instanceof ChatApiError) throw err;
    throw new ChatApiError(AUTH_SESSION_ERROR_MESSAGE, 'auth', 401);
  }
}

export interface SerializedHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
  attachmentSummary?: string;
}

/**
 * Builds a request-only conversation history aligned with backend validation limits:
 * - max 28 most recent turns
 * - max 8,000 chars per turn (and 1,000 chars attachment summary)
 * - max 48,000 aggregate characters across turns
 * Never mutates the caller's local ChatMessage[] array or persisted IndexedDB history.
 */
export function buildBoundedSerializedHistory(
  history: ReadonlyArray<ChatMessage>
): SerializedHistoryTurn[] {
  const candidates: SerializedHistoryTurn[] = [];

  for (const m of history) {
    if (
      m.error ||
      m.isStreaming ||
      (m.role !== 'user' && m.role !== 'assistant')
    ) {
      continue;
    }

    const hasAttachments = Array.isArray(m.attachments) && m.attachments.length > 0;
    if (m.content.trim().length === 0 && !hasAttachments) {
      continue;
    }

    const boundedContent =
      m.content.length > MAX_HISTORY_TURN_CHARS
        ? m.content.slice(0, MAX_HISTORY_TURN_CHARS)
        : m.content;

    const rawSummary = hasAttachments
      ? m.attachments!.map((a) => a.name).join(', ')
      : '';
    const boundedSummary =
      rawSummary.length > MAX_ATTACHMENT_SUMMARY_CHARS
        ? rawSummary.slice(0, MAX_ATTACHMENT_SUMMARY_CHARS)
        : rawSummary;

    candidates.push({
      role: m.role,
      content: boundedContent,
      ...(boundedSummary ? { attachmentSummary: boundedSummary } : {}),
    });
  }

  const recentWindow =
    candidates.length > MAX_HISTORY_TURNS
      ? candidates.slice(candidates.length - MAX_HISTORY_TURNS)
      : candidates;

  const selectedReversed: SerializedHistoryTurn[] = [];
  let totalChars = 0;

  for (let i = recentWindow.length - 1; i >= 0; i--) {
    const turn = recentWindow[i];
    const turnChars = turn.content.length + (turn.attachmentSummary?.length ?? 0);
    if (totalChars + turnChars > MAX_HISTORY_TOTAL_CHARS) {
      break;
    }
    totalChars += turnChars;
    selectedReversed.push(turn);
  }

  return selectedReversed.reverse();
}

function buildChatFormData(params: {
  message: string;
  webSearch: boolean;
  serializedHistory: SerializedHistoryTurn[];
  files: File[];
}): FormData {
  const formData = new FormData();
  formData.append('message', params.message);
  formData.append('webSearch', String(params.webSearch));
  formData.append('history', JSON.stringify(params.serializedHistory));

  for (const file of params.files) {
    formData.append('files', file);
  }
  return formData;
}

export interface StreamChatParams {
  history: ChatMessage[];
  message: string;
  webSearch: boolean;
  files: File[];
  signal: AbortSignal;
  onStatus: (phase: StreamPhase) => void;
  onDelta: (text: string) => void;
  onDone: (grounding: GroundingInfo) => void;
}

export async function streamChatCompletion({
  history,
  message,
  webSearch,
  files,
  signal,
  onStatus,
  onDelta,
  onDone,
}: StreamChatParams): Promise<void> {
  const preValidation = validateOutgoingPayload({ message, files });
  if (!preValidation.valid) {
    throw new ChatApiError(
      preValidation.error ?? 'Please check your message or attached files and try again.',
      'retryable',
      preValidation.code === 'TOTAL_UPLOAD_TOO_LARGE' ? 413 : 400,
      preValidation.code
    );
  }

  const serializedHistory = buildBoundedSerializedHistory(history);

  const initialToken = await getRequiredIdToken(false);
  let response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${initialToken}`,
    },
    body: buildChatFormData({ message, webSearch, serializedHistory, files }),
    signal,
  });

  // Controlled single retry with a force-refreshed Firebase ID token if 401 is returned
  if (response.status === 401 && !signal.aborted) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cancellation errors on rejected response body
    }
    const refreshedToken = await getRequiredIdToken(true);
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshedToken}`,
      },
      body: buildChatFormData({ message, webSearch, serializedHistory, files }),
      signal,
    });
  }

  if (!response.ok) {
    let rawError: string | undefined;
    let errorCode: string | undefined;
    let bodyRetryAfter: unknown;
    try {
      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        retryAfterSeconds?: number;
      };
      if (typeof payload?.error === 'string') {
        rawError = payload.error;
      }
      if (typeof payload?.code === 'string') {
        errorCode = payload.code;
      }
      bodyRetryAfter = payload?.retryAfterSeconds;
    } catch {
      // Keep status-based fallback
    }

    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get('Retry-After'),
      bodyRetryAfter
    );

    const classified = classifyChatError({
      statusCode: response.status,
      rawMessage: rawError,
      code: errorCode,
      retryAfterSeconds,
    });
    throw new ChatApiError(
      classified.message,
      classified.kind,
      classified.statusCode,
      classified.code,
      classified.retryAfterSeconds
    );
  }

  if (!response.body) {
    throw new ChatApiError(GENERIC_CHAT_ERROR_MESSAGE, 'retryable');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (rawEvent.startsWith('data:')) {
        const jsonPayload = rawEvent.slice(5).trim();
        if (jsonPayload) {
          let parsed: {
            type?: string;
            phase?: StreamPhase;
            text?: string;
            grounding?: GroundingInfo;
            statusCode?: number;
            error?: string;
            code?: string;
            retryAfterSeconds?: number;
          };
          try {
            parsed = JSON.parse(jsonPayload);
          } catch {
            boundary = buffer.indexOf('\n\n');
            continue;
          }

          if (parsed.type === 'status' && parsed.phase) {
            onStatus(parsed.phase);
          } else if (parsed.type === 'delta' && typeof parsed.text === 'string') {
            onDelta(parsed.text);
          } else if (parsed.type === 'done') {
            receivedDone = true;
            onDone(
              parsed.grounding ?? {
                enabled: webSearch,
                used: false,
                searchQueries: [],
                sources: [],
              }
            );
          } else if (parsed.type === 'error') {
            const retryAfterSeconds = parseRetryAfterSeconds(
              null,
              parsed.retryAfterSeconds
            );
            const classified = classifyChatError({
              statusCode:
                typeof parsed.statusCode === 'number' ? parsed.statusCode : undefined,
              rawMessage: typeof parsed.error === 'string' ? parsed.error : undefined,
              code: typeof parsed.code === 'string' ? parsed.code : undefined,
              retryAfterSeconds,
            });
            throw new ChatApiError(
              classified.message,
              classified.kind,
              classified.statusCode,
              classified.code,
              classified.retryAfterSeconds
            );
          }
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  if (!receivedDone && !signal.aborted) {
    onDone({
      enabled: webSearch,
      used: false,
      searchQueries: [],
      sources: [],
    });
  }
}

export async function fetchFollowUpSuggestions(params: {
  userMessage: string;
  assistantMessage: string;
  contentType?: string | null;
  signal?: AbortSignal;
}): Promise<string[]> {
  try {
    if (!auth.currentUser) {
      return [];
    }

    const body = JSON.stringify({
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      contentType: params.contentType ?? null,
    });

    const initialToken = await getRequiredIdToken(false);
    let response = await fetch('/api/followups', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${initialToken}`,
      },
      body,
      signal: params.signal,
    });

    if (response.status === 401 && !params.signal?.aborted) {
      const refreshedToken = await getRequiredIdToken(true);
      response = await fetch('/api/followups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${refreshedToken}`,
        },
        body,
        signal: params.signal,
      });
    }

    if (!response.ok) return [];
    const data = (await response.json()) as { suggestions?: unknown };
    if (!Array.isArray(data.suggestions)) return [];
    return data.suggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  } catch {
    return [];
  }
}
