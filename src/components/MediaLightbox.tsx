import { useEffect } from 'react';
import { X } from 'lucide-react';

interface MediaLightboxProps {
  imageUrl: string | null;
  alt: string;
  onClose: () => void;
}

export function MediaLightbox({ imageUrl, alt, onClose }: MediaLightboxProps) {
  useEffect(() => {
    if (!imageUrl) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imageUrl, onClose]);

  if (!imageUrl) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      onClick={onClose}
    >
      <div
        className="glass-panel relative max-h-[90vh] max-w-4xl overflow-hidden rounded-3xl p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-3 pb-2 pt-1">
          <span className="truncate text-sm font-medium text-white/85">{alt}</span>
          <button
            type="button"
            onClick={onClose}
            className="glass-control flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/80 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
            aria-label="Close image preview"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <img
          src={imageUrl}
          alt={alt}
          referrerPolicy="no-referrer"
          className="max-h-[78vh] w-auto rounded-2xl object-contain"
        />
      </div>
    </div>
  );
}
