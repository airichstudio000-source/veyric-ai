import { useEffect, useRef } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import {
  AlertCircle,
  ArrowUp,
  FileText,
  Film,
  Globe,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import type { PendingAttachment } from '../types/chat';
import { FILE_INPUT_ACCEPT, formatFileSize } from '../lib/fileValidation';
import { playClickSound } from '../lib/sound';

interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  attachments: PendingAttachment[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentError: string | null;
  onDismissAttachmentError: () => void;
  webSearch: boolean;
  onToggleWebSearch: () => void;
  isStreaming: boolean;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
}

export function ChatComposer({
  input,
  onInputChange,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  attachmentError,
  onDismissAttachmentError,
  webSearch,
  onToggleWebSearch,
  isStreaming,
  onSend,
  onStop,
  disabled = false,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [input]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!isStreaming && canSend) {
        onSend();
      }
    }
  };

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="pointer-events-none sticky bottom-0 z-20 w-full px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl">
        <div className="glass-floating rounded-[28px] p-2.5 sm:p-3">
          {/* Attachment validation warning */}
          {attachmentError && (
            <div
              role="alert"
              className="mb-2.5 flex items-center justify-between gap-2 rounded-2xl border border-rose-300/35 bg-rose-500/18 px-3 py-2 text-xs text-rose-50"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-200" />
                <span>{attachmentError}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  onDismissAttachmentError();
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-rose-100 transition-colors hover:bg-white/15 active:scale-95"
                aria-label="Dismiss file error"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Pending Attachments Tray */}
          {attachments.length > 0 && (
            <div className="glass-scroll mb-2.5 flex gap-2 overflow-x-auto pb-1">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative flex shrink-0 items-center gap-2.5 rounded-2xl border border-white/32 bg-white/[0.14] p-2 pr-8"
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      referrerPolicy="no-referrer"
                      className="h-11 w-11 rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/10 text-sky-200">
                      {att.kind === 'video' ? (
                        <Film className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </div>
                  )}
                  <div className="max-w-[140px]">
                    <p className="truncate text-xs font-medium text-white">{att.name}</p>
                    <p className="text-[11px] tabular-nums text-white/55">
                      {formatFileSize(att.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      playClickSound();
                      onRemoveAttachment(att.id);
                    }}
                    className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-white/85 transition-all hover:bg-black/75 hover:text-white active:scale-90 focus-visible:outline-2 focus-visible:outline-white"
                    aria-label={`Remove ${att.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Message Textarea */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message VEYRIC AI in English or Burmese…"
            aria-label="Message input"
            disabled={disabled}
            className="glass-scroll max-h-[168px] min-h-[44px] w-full resize-none bg-transparent px-2.5 py-2 text-[15px] leading-relaxed text-white placeholder:text-white/65 focus:outline-none sm:text-[15.5px]"
          />

          {/* Bottom Controls */}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={FILE_INPUT_ACCEPT}
                onChange={handleFileChange}
                className="hidden"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  fileInputRef.current?.click();
                }}
                disabled={isStreaming || disabled}
                className="glass-control inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-medium text-white/90 hover:text-white disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-white"
                aria-label="Attach image, video, or document"
                title="Attach JPG, PNG, WEBP, MP4, MOV, PDF, TXT, DOCX"
              >
                <Paperclip className="h-4 w-4" />
                <span className="hidden whitespace-nowrap sm:inline">Attach</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  playClickSound();
                  onToggleWebSearch();
                }}
                aria-pressed={webSearch}
                disabled={isStreaming}
                className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-2xl border px-3 text-xs font-medium transition-all duration-150 active:scale-95 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 ${
                  webSearch
                    ? 'border-white/65 bg-sky-300/32 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_4px_14px_-4px_rgba(125,211,252,0.35)] hover:bg-sky-300/42'
                    : 'border-white/35 bg-white/[0.14] text-white/90 hover:border-white/55 hover:bg-white/[0.22] hover:text-white'
                }`}
                aria-label={webSearch ? 'Disable web search grounding' : 'Enable web search grounding'}
              >
                <Globe className="h-3.5 w-3.5" />
                <span className="whitespace-nowrap">Web Search</span>
              </button>
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="glass-control inline-flex h-10 min-w-[40px] items-center justify-center gap-1.5 rounded-2xl px-3.5 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-white"
                aria-label="Stop generating response"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span className="whitespace-nowrap">Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-slate-950 shadow-[0_4px_18px_rgba(255,255,255,0.28)] transition-all duration-150 hover:scale-[1.03] hover:bg-sky-50 active:scale-95 disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/40 disabled:shadow-none disabled:hover:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                aria-label="Send message"
              >
                <ArrowUp className="h-4.5 w-4.5 stroke-[2.25]" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
