import { useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileText,
  Film,
  Globe,
  LogOut,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import type { ChatErrorKind, ChatMessage, MessageAttachment } from '../types/chat';
import {
  detectContentBlockType,
  extractPromptDisplay,
} from '../lib/contentDetector';
import { formatFileSize } from '../lib/fileValidation';
import { playClickSound } from '../lib/sound';
import { ContentBlock } from './ContentBlock';
import { GlassBrandLogo } from './GlassBrandLogo';
import { MarkdownRenderer } from './MarkdownRenderer';
import { PromptCard } from './PromptCard';
import { ThinkingIndicator } from './ThinkingIndicator';

interface MessageBubbleProps {
  message: ChatMessage;
  precedingUserPrompt?: string;
  isLatestAssistant?: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onReauthenticate?: () => void;
  onSelectFollowUp?: (suggestion: string) => void;
  onPreviewImage: (url: string, name: string) => void;
}

function inferErrorKind(errorText: string): ChatErrorKind {
  const lower = errorText.toLowerCase();
  if (
    lower.includes('session has expired') ||
    lower.includes('could not be verified') ||
    lower.includes('please sign in') ||
    lower.includes('authentication')
  ) {
    return 'auth';
  }
  if (
    lower.includes('usage limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('sending messages too quickly') ||
    lower.includes('too many requests from your network') ||
    lower.includes('daily free chat limit') ||
    lower.includes('daily free usage limit') ||
    lower.includes('active chat requests') ||
    lower.includes('utc midnight') ||
    /\b429\b/.test(lower)
  ) {
    return 'quota';
  }
  return 'retryable';
}

function AttachmentCard({
  attachment,
  onPreviewImage,
}: {
  attachment: MessageAttachment;
  onPreviewImage: (url: string, name: string) => void;
}) {
  if (attachment.kind === 'image' && attachment.previewUrl) {
    return (
      <button
        type="button"
        onClick={() => {
          playClickSound();
          onPreviewImage(attachment.previewUrl!, attachment.name);
        }}
        className="group relative overflow-hidden rounded-2xl border border-white/35 bg-black/25 text-left transition-transform duration-150 hover:scale-[1.015] active:scale-[0.985] focus-visible:outline-2 focus-visible:outline-white"
        aria-label={`Preview ${attachment.name}`}
      >
        <img
          src={attachment.previewUrl}
          alt={attachment.name}
          referrerPolicy="no-referrer"
          className="h-36 w-48 object-cover sm:h-40 sm:w-56"
        />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 pb-2 pt-5">
          <p className="truncate text-xs font-medium text-white/95">{attachment.name}</p>
        </div>
      </button>
    );
  }

  if (attachment.kind === 'video' && attachment.previewUrl) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/15 bg-black/40">
        <video
          src={attachment.previewUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-48 w-64 rounded-t-2xl bg-black sm:w-72"
        />
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-white/75">
          <span className="truncate font-medium text-white/90">{attachment.name}</span>
          <span className="shrink-0 tabular-nums text-white/55">
            {formatFileSize(attachment.size)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[260px] items-center gap-3 rounded-2xl border border-white/14 bg-white/[0.06] px-3.5 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-sky-200">
        {attachment.kind === 'video' ? (
          <Film className="h-4 w-4" />
        ) : (
          <FileText className="h-4 w-4" />
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-white/95">{attachment.name}</p>
        <p className="text-[11px] tabular-nums text-white/55">
          {formatFileSize(attachment.size)}
        </p>
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  precedingUserPrompt = '',
  isLatestAssistant = false,
  canRetry,
  onRetry,
  onReauthenticate,
  onSelectFollowUp,
  onPreviewImage,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  // Capture streaming/freshly mounted state on initial mount so entrance animation only plays for new messages
  const shouldAnimateResponseRef = useRef(Boolean(message.isStreaming));
  const [animateBubble] = useState(
    () => Boolean(message.isStreaming) || Date.now() - message.createdAt < 2500
  );
  const [bubbleAnimated, setBubbleAnimated] = useState(false);

  const handleCopy = async () => {
    if (!message.content) return;
    playClickSound();
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const formattedTime = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(message.createdAt);

  if (message.role === 'user') {
    return (
      <div
        className={`flex justify-end ${animateBubble && !bubbleAnimated ? 'veyric-message-enter' : ''}`}
        onAnimationEnd={() => setBubbleAnimated(true)}
      >
        <div className="max-w-[88%] sm:max-w-[78%] md:max-w-[72%]">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {message.attachments.map((att) => (
                <AttachmentCard
                  key={att.id}
                  attachment={att}
                  onPreviewImage={onPreviewImage}
                />
              ))}
            </div>
          )}
          {message.content.trim().length > 0 && (
            <div className="glass-user-bubble rounded-[26px] rounded-br-lg px-4 py-3 sm:px-5 sm:py-3.5">
              <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-white sm:text-[15.5px]">
                {message.content}
              </p>
            </div>
          )}
          <div className="mt-1.5 flex justify-end px-1">
            <span className="text-[11px] tabular-nums text-white/80">{formattedTime}</span>
          </div>
        </div>
      </div>
    );
  }

  const sources = message.grounding?.sources ?? [];
  const searchQueries = message.grounding?.searchQueries ?? [];
  const hasContent = message.content.trim().length > 0;

  const promptDisplay = extractPromptDisplay(
    precedingUserPrompt,
    message.content,
    Boolean(message.isStreaming)
  );
  const contentBlockType = promptDisplay
    ? null
    : detectContentBlockType(
        precedingUserPrompt,
        message.content,
        Boolean(message.isStreaming)
      );
  const followUps =
    isLatestAssistant && !message.isStreaming && !message.error
      ? (message.followUpSuggestions ?? [])
      : [];

  const isStructuredDeliverable = Boolean(contentBlockType && hasContent);
  const resolvedErrorKind: ChatErrorKind | null = message.error
    ? (message.errorKind ?? inferErrorKind(message.error))
    : null;

  return (
    <div
      className={`flex items-start gap-3 sm:gap-4 ${animateBubble && !bubbleAnimated ? 'veyric-message-enter' : ''}`}
      onAnimationEnd={() => setBubbleAnimated(true)}
    >
      <div className="mt-1 hidden shrink-0 sm:block">
        <GlassBrandLogo size={30} />
      </div>

      <div className="min-w-0 flex-1">
        <div
          className={`${
            isStructuredDeliverable ? 'glass-panel overflow-hidden' : 'glass-surface'
          } rounded-[26px] rounded-tl-lg px-4 py-4 sm:px-6 sm:py-5`}
        >
          {/* Header metadata line (clean unboxed text, no pills) */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/75">
            <div className="flex items-center gap-2">
              <span className="font-display font-medium text-white">VEYRIC AI</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formattedTime}</span>
              {!message.isStreaming && !message.error && message.grounding?.used && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-white/95">
                    <Globe className="h-3 w-3" />
                    <span>
                      Grounded via Google Search
                      {sources.length > 0 ? ` (${sources.length})` : ''}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Subtle Thinking... Indicator while awaiting first response token */}
          {message.isStreaming && !hasContent && !message.error && (
            <ThinkingIndicator phase={message.streamPhase} />
          )}

          {/* Incoming Response Content with single-shot Fade-In entrance */}
          {hasContent && (
            <div
              className={shouldAnimateResponseRef.current ? 'veyric-response-enter' : undefined}
              onAnimationEnd={() => {
                shouldAnimateResponseRef.current = false;
              }}
            >
              {promptDisplay ? (
                <div className="space-y-3">
                  {promptDisplay.beforeText && (
                    <MarkdownRenderer content={promptDisplay.beforeText} />
                  )}
                  {promptDisplay.prompts.map((item) => (
                    <PromptCard
                      key={item.id}
                      kind={item.kind}
                      heading={item.heading}
                      promptText={item.promptText}
                    />
                  ))}
                  {promptDisplay.afterText && (
                    <MarkdownRenderer content={promptDisplay.afterText} />
                  )}
                </div>
              ) : contentBlockType ? (
                <ContentBlock
                  type={contentBlockType}
                  content={message.content}
                  isStreaming={Boolean(message.isStreaming)}
                />
              ) : (
                <MarkdownRenderer content={message.content} />
              )}
            </div>
          )}

          {/* Error Banner */}
          {message.error && resolvedErrorKind === 'quota' && (
            <div
              role="alert"
              data-error-kind="quota"
              className="mt-3 flex items-start gap-2.5 rounded-2xl border border-amber-300/35 bg-amber-500/12 p-3.5 text-sm text-amber-50"
            >
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
              <span>{message.error}</span>
            </div>
          )}

          {message.error && resolvedErrorKind === 'auth' && (
            <div
              role="alert"
              data-error-kind="auth"
              className="mt-3 flex flex-col gap-3 rounded-2xl border border-sky-300/35 bg-sky-500/12 p-3.5 text-sm text-sky-50 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-sky-200" />
                <span>{message.error}</span>
              </div>
              {onReauthenticate && (
                <button
                  type="button"
                  onClick={() => {
                    playClickSound();
                    onReauthenticate();
                  }}
                  className="glass-control inline-flex min-h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-white"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign in again</span>
                </button>
              )}
            </div>
          )}

          {message.error && resolvedErrorKind === 'retryable' && (
            <div
              role="alert"
              data-error-kind="retryable"
              className="mt-3 flex flex-col gap-3 rounded-2xl border border-rose-300/25 bg-rose-500/10 p-3.5 text-sm text-rose-100 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                <span>{message.error}</span>
              </div>
              <button
                type="button"
                onClick={onRetry}
                className="glass-control inline-flex min-h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Grounded Web Sources */}
          {!message.isStreaming && sources.length > 0 && (
            <div className="mt-5 border-t border-white/25 pt-4">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <span className="font-display text-xs font-medium text-white/90">
                  Verified Web Sources
                </span>
                {searchQueries.length > 0 && (
                  <span className="truncate text-[11px] text-white/70">
                    Searched: {searchQueries.join(' · ')}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {sources.map((src, index) => (
                  <a
                    key={src.uri}
                    href={src.uri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex min-h-[44px] items-center justify-between gap-3 rounded-2xl border border-white/28 bg-white/[0.12] px-3.5 py-2.5 transition-colors hover:border-white/55 hover:bg-white/[0.20] focus-visible:outline-2 focus-visible:outline-white"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-white group-hover:text-white">
                        {index + 1}. {src.title}
                      </p>
                      <p className="truncate text-[11px] text-white/75">{src.domain}</p>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/70 transition-colors group-hover:text-white" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Message Actions (omit duplicate Copy when ContentBlock provides Copy all / Export) */}
          {!message.isStreaming &&
            ((hasContent && !isStructuredDeliverable) || (canRetry && !message.error)) && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/20 pt-3">
                {hasContent && !isStructuredDeliverable && (
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-white/85 transition-all duration-150 hover:bg-white/[0.16] hover:text-white active:scale-95 focus-visible:outline-2 focus-visible:outline-white"
                    aria-label="Copy AI response"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-sky-200" />
                        <span className="text-white">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                )}
                {canRetry && !message.error && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium text-white/85 transition-all duration-150 hover:bg-white/[0.16] hover:text-white active:scale-95 focus-visible:outline-2 focus-visible:outline-white"
                    aria-label="Regenerate response"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Retry</span>
                  </button>
                )}
              </div>
            )}
        </div>

        {/* Contextual Follow-Up Suggestions */}
        {followUps.length > 0 && onSelectFollowUp && (
          <div
            className="veyric-response-enter mt-2.5 flex flex-wrap gap-2"
            aria-label="Suggested follow-up prompts"
          >
            {followUps.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSelectFollowUp(suggestion)}
                className="glass-control inline-flex min-h-[38px] items-center gap-2 rounded-2xl px-3.5 py-2 text-left text-xs font-medium text-white/90 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              >
                <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-sky-200/80" />
                <span>{suggestion}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
