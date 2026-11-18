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
      className="inline-flex items-center py-1.5 text-sm font-medium text-white/90"
      role="status"
      aria-live="polite"
      aria-label={`${label}...`}
    >
      <span>{label}</span>
      <span className="inline-flex w-5 tracking-wider" aria-hidden="true">
        <span className="veyric-thinking-dot veyric-thinking-dot-1">.</span>
        <span className="veyric-thinking-dot veyric-thinking-dot-2">.</span>
        <span className="veyric-thinking-dot veyric-thinking-dot-3">.</span>
      </span>
    </div>
  );
}
