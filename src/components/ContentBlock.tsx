import { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Clapperboard,
  Copy,
  Download,
  FileEdit,
  Mail,
  Megaphone,
  Share2,
} from 'lucide-react';
import type { StructuredContentType } from '../lib/contentDetector';
import {
  getContentTypeMeta,
  parseContentSections,
} from '../lib/contentDetector';
import { playClickSound } from '../lib/sound';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ContentBlockProps {
  type: StructuredContentType;
  content: string;
  isStreaming: boolean;
}

function ContentTypeIcon({ type }: { type: StructuredContentType }) {
  const className = 'h-4 w-4 text-white/85';
  switch (type) {
    case 'video_script':
      return <Clapperboard className={className} />;
    case 'professional_email':
      return <Mail className={className} />;
    case 'social_caption':
      return <Share2 className={className} />;
    case 'marketing_copy':
      return <Megaphone className={className} />;
    case 'storytelling':
      return <BookOpen className={className} />;
    case 'content_writing':
    default:
      return <FileEdit className={className} />;
  }
}

export function ContentBlock({ type, content, isStreaming }: ContentBlockProps) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedSectionId, setCopiedSectionId] = useState<string | null>(null);

  const meta = getContentTypeMeta(type);
  const sections = useMemo(
    () => (isStreaming ? [] : parseContentSections(content)),
    [content, isStreaming]
  );

  const handleCopyAll = async () => {
    if (!content.trim()) return;
    playClickSound();
    try {
      await navigator.clipboard.writeText(content);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    } catch {
      // Clipboard API unavailable
    }
  };

  const handleCopySection = async (id: string, title: string, body: string) => {
    playClickSound();
    try {
      await navigator.clipboard.writeText(`${title}\n\n${body}`);
      setCopiedSectionId(id);
      setTimeout(() => setCopiedSectionId(null), 1800);
    } catch {
      // Clipboard API unavailable
    }
  };

  const handleDownload = () => {
    if (!content.trim()) return;
    playClickSound();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${meta.filenamePrefix}.${meta.fileExtension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const copyAllLabel = type === 'video_script' ? 'Copy Script' : 'Copy All';

  return (
    <div className="-mx-4 -my-1 sm:-mx-6">
      {/* Structured Script / Editorial Content Header Band */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-y border-white/25 bg-white/[0.10] px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/30 bg-white/[0.15]">
            <ContentTypeIcon type={type} />
          </div>
          <div className="flex items-center gap-2">
            <h4 className="font-display text-xs font-semibold tracking-wide text-white sm:text-[13px]">
              {meta.label}
            </h4>
            {sections.length > 1 && (
              <>
                <span className="text-white/45" aria-hidden="true">
                  ·
                </span>
                <span className="text-[11px] tabular-nums text-white/80">
                  {sections.length} sections
                </span>
              </>
            )}
          </div>
        </div>

        {!isStreaming && content.trim().length > 0 && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyAll}
              className="glass-control inline-flex min-h-[34px] items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium text-white/85 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              aria-label={`Copy entire ${meta.label}`}
            >
              {copiedAll ? (
                <>
                  <Check className="h-3.5 w-3.5 text-sky-300" />
                  <span className="text-sky-200">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>{copyAllLabel}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="glass-control inline-flex min-h-[34px] items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium text-white/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
              aria-label={`Download ${meta.label}`}
              title={`Download as .${meta.fileExtension}`}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </button>
          </div>
        )}
      </div>

      {/* Content Body (Sectioned or Single Block) */}
      {sections.length >= 2 ? (
        <div className="divide-y divide-white/20">
          {sections.map((section) => (
            <div key={section.id} className="px-4 py-3.5 sm:px-6 sm:py-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h5 className="font-display text-sm font-semibold text-white">
                  {section.title}
                </h5>
                <button
                  type="button"
                  onClick={() => handleCopySection(section.id, section.title, section.body)}
                  className="inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/[0.15] hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                  aria-label={`Copy ${section.title} section`}
                >
                  {copiedSectionId === section.id ? (
                    <>
                      <Check className="h-3 w-3 text-sky-300" />
                      <span className="text-sky-200">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy section</span>
                    </>
                  )}
                </button>
              </div>
              <MarkdownRenderer content={section.body} />
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-3.5 sm:px-6 sm:py-4">
          <MarkdownRenderer content={content} />
        </div>
      )}
    </div>
  );
}
