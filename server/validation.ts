import { protectionConfig } from './config.ts';
import type { ProtectionConfig } from './config.ts';
import { HttpError } from './gemini.ts';
import type { IncomingHistoryMessage } from './gemini.ts';

export type PayloadValidationErrorCode =
  | 'INVALID_PROMPT'
  | 'PROMPT_TOO_LONG'
  | 'INVALID_HISTORY'
  | 'HISTORY_TOO_MANY_TURNS'
  | 'HISTORY_TURN_TOO_LONG'
  | 'HISTORY_TOO_LARGE'
  | 'EMPTY_REQUEST'
  | 'INVALID_FOLLOWUP_PAYLOAD';

const MAX_ATTACHMENT_SUMMARY_CHARS = 1000;

export class PayloadValidationError extends HttpError {
  code: PayloadValidationErrorCode;

  constructor(code: PayloadValidationErrorCode, message: string, statusCode = 400) {
    super(statusCode, message);
    this.name = 'PayloadValidationError';
    this.code = code;
  }
}

export interface ValidatedChatPayload {
  message: string;
  webSearch: boolean;
  history: IncomingHistoryMessage[];
}

export function validateChatPayload(params: {
  body: Record<string, unknown> | undefined;
  fileCount: number;
  config?: ProtectionConfig;
}): ValidatedChatPayload {
  const config = params.config ?? protectionConfig;
  const body = params.body ?? {};

  // 1. Validate prompt type and character length
  const rawMessageField = body.message;
  if (rawMessageField !== undefined && typeof rawMessageField !== 'string') {
    throw new PayloadValidationError(
      'INVALID_PROMPT',
      'Prompt must be a valid text string.'
    );
  }
  const message = typeof rawMessageField === 'string' ? rawMessageField : '';

  if (message.length > config.limits.maxPromptChars) {
    throw new PayloadValidationError(
      'PROMPT_TOO_LONG',
      `Prompt is too long. Maximum allowed length is ${config.limits.maxPromptChars} characters.`
    );
  }

  // 2. Parse and validate webSearch flag
  const webSearch = body.webSearch === 'true' || body.webSearch === true;

  // 3. Parse and strictly validate conversation history
  const rawHistoryField = body.history;
  if (rawHistoryField !== undefined && typeof rawHistoryField !== 'string') {
    throw new PayloadValidationError(
      'INVALID_HISTORY',
      'Invalid conversation history format.'
    );
  }

  let history: IncomingHistoryMessage[] = [];
  if (typeof rawHistoryField === 'string' && rawHistoryField.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawHistoryField);
    } catch {
      throw new PayloadValidationError(
        'INVALID_HISTORY',
        'Could not parse conversation history.'
      );
    }

    if (!Array.isArray(parsed)) {
      throw new PayloadValidationError(
        'INVALID_HISTORY',
        'Invalid conversation history format.'
      );
    }

    if (parsed.length > config.limits.maxHistoryTurns) {
      throw new PayloadValidationError(
        'HISTORY_TOO_MANY_TURNS',
        `Conversation history exceeds the maximum of ${config.limits.maxHistoryTurns} turns.`
      );
    }

    let totalHistoryChars = 0;
    const validatedTurns: IncomingHistoryMessage[] = [];

    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new PayloadValidationError(
          'INVALID_HISTORY',
          'Invalid conversation history entry.'
        );
      }

      const record = item as Record<string, unknown>;
      if (
        (record.role !== 'user' && record.role !== 'assistant') ||
        typeof record.content !== 'string'
      ) {
        throw new PayloadValidationError(
          'INVALID_HISTORY',
          'Invalid conversation history entry.'
        );
      }

      if (
        record.attachmentSummary !== undefined &&
        typeof record.attachmentSummary !== 'string'
      ) {
        throw new PayloadValidationError(
          'INVALID_HISTORY',
          'Invalid attachment summary in conversation history.'
        );
      }

      if (record.content.length > config.limits.maxHistoryTurnChars) {
        throw new PayloadValidationError(
          'HISTORY_TURN_TOO_LONG',
          `A conversation history message exceeds the ${config.limits.maxHistoryTurnChars} character limit.`
        );
      }

      const attachmentSummary =
        typeof record.attachmentSummary === 'string' ? record.attachmentSummary : undefined;

      if (attachmentSummary && attachmentSummary.length > MAX_ATTACHMENT_SUMMARY_CHARS) {
        throw new PayloadValidationError(
          'HISTORY_TURN_TOO_LONG',
          'An attachment summary in conversation history exceeds the allowed length.'
        );
      }

      totalHistoryChars += record.content.length + (attachmentSummary?.length ?? 0);
      if (totalHistoryChars > config.limits.maxHistoryTotalChars) {
        throw new PayloadValidationError(
          'HISTORY_TOO_LARGE',
          `Conversation history exceeds the aggregate ${config.limits.maxHistoryTotalChars} character limit.`
        );
      }

      validatedTurns.push({
        role: record.role,
        content: record.content,
        ...(attachmentSummary ? { attachmentSummary } : {}),
      });
    }

    history = validatedTurns;
  }

  // 4. Ensure message is not completely empty when no files are attached
  if (!message.trim() && params.fileCount === 0) {
    throw new PayloadValidationError(
      'EMPTY_REQUEST',
      'Please enter a message or attach a supported file.'
    );
  }

  return {
    message,
    webSearch,
    history,
  };
}

export interface ValidatedFollowupPayload {
  userMessage: string;
  assistantMessage: string;
  contentType: string | null;
}

export function validateFollowupPayload(params: {
  body: Record<string, unknown> | undefined;
  config?: ProtectionConfig;
}): ValidatedFollowupPayload {
  const config = params.config ?? protectionConfig;
  const body = params.body ?? {};

  if (body.userMessage !== undefined && typeof body.userMessage !== 'string') {
    throw new PayloadValidationError(
      'INVALID_FOLLOWUP_PAYLOAD',
      'Invalid follow-up user message.'
    );
  }
  if (body.assistantMessage !== undefined && typeof body.assistantMessage !== 'string') {
    throw new PayloadValidationError(
      'INVALID_FOLLOWUP_PAYLOAD',
      'Invalid follow-up assistant message.'
    );
  }
  if (
    body.contentType !== undefined &&
    body.contentType !== null &&
    typeof body.contentType !== 'string'
  ) {
    throw new PayloadValidationError(
      'INVALID_FOLLOWUP_PAYLOAD',
      'Invalid follow-up content type.'
    );
  }

  const userMessage = typeof body.userMessage === 'string' ? body.userMessage : '';
  const assistantMessage =
    typeof body.assistantMessage === 'string' ? body.assistantMessage : '';
  const contentType = typeof body.contentType === 'string' ? body.contentType : null;

  if (
    userMessage.length > config.limits.maxPromptChars ||
    assistantMessage.length > config.limits.maxHistoryTurnChars ||
    (contentType && contentType.length > 64)
  ) {
    throw new PayloadValidationError(
      'INVALID_FOLLOWUP_PAYLOAD',
      'Follow-up request payload exceeds allowed character limits.'
    );
  }

  return {
    userMessage,
    assistantMessage,
    contentType,
  };
}
