import type { StreamPhase } from '../types/chat';

interface ThinkingIndicatorProps {
  phase?: StreamPhase;
}

function getPhaseText(phase?: StreamPhase): string {
  switch (phase) {
    case 'processing_files':
      return 'Processing files';
    case 'searching':
      return 'Searching the web';
    case 'generating':
    default:
      return 'Thinking';
  }
}

export function ThinkingIndicator({ phase }: ThinkingIndicatorProps) {
  const label = getPhaseText(phase);

  return (
    <div
      className="inline-flex items-center gap-2 py-1.5 text-sm font-medium text-white/95"
      role="status"
      aria-live="polite"
      aria-label={`${label}...`}
    >
      <span
        className="veyric-loading-orb h-2 w-2 rounded-full bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.65)]"
        aria-hidden="true"
      />
      <span>{label}</span>
      <span className="inline-flex w-5 tracking-wider" aria-hidden="true">
        <span className="veyric-thinking-dot veyric-thinking-dot-1">.</span>
        <span className="veyric-thinking-dot veyric-thinking-dot-2">.</span>
        <span className="veyric-thinking-dot veyric-thinking-dot-3">.</span>
      </span>
    </div>
  );
}
