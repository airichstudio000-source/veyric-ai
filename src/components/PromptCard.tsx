import { useState } from 'react';
import { Check, Copy, Film, Image as ImageIcon, Terminal } from 'lucide-react';
import type { PromptKind } from '../lib/contentDetector';

interface PromptCardProps {
  kind: PromptKind;
  heading: string;
  promptText: string;
}

function PromptKindIcon({ kind }: { kind: PromptKind }) {
  const className = 'h-3.5 w-3.5 text-sky-200';
  switch (kind) {
    case 'image':
      return <ImageIcon className={className} />;
    case 'video':
    case 'text_to_video':
    case 'image_to_video':
      return <Film className={className} />;
    case 'general':
    default:
      return <Terminal className={className} />;
  }
}

export function PromptCard({ kind, heading, promptText }: PromptCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = async () => {
    const cleanText = promptText.trim();
    if (!cleanText) return;
    try {
      await navigator.clipboard.writeText(cleanText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable
    }
  };

  return (
    <div className="glass-prompt-card my-2.5 overflow-hidden rounded-2xl">
      {/* Dedicated Prompt Header */}
      <div className="flex items-center justify-between gap-3 border-b border-white/25 bg-white/[0.10] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/30 bg-white/15">
            <PromptKindIcon kind={kind} />
          </span>
          <span className="font-display text-xs font-semibold tracking-wider text-white">
            {heading}
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopyPrompt}
          className="glass-control inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-white hover:text-white focus-visible:outline-2 focus-visible:outline-white"
          aria-label={`Copy ${heading.toLowerCase()} content`}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-sky-300" />
              <span className="text-sky-200">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy Prompt</span>
            </>
          )}
        </button>
      </div>

      {/* Pure Prompt Content (isolated from surrounding headings/descriptions) */}
      <div className="px-4 py-3.5 sm:px-5 sm:py-4">
        <p className="whitespace-pre-wrap break-words text-[14.5px] leading-relaxed text-white/95 sm:text-[15px]">
          {promptText.trim()}
        </p>
      </div>
    </div>
  );
}
