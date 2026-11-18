interface GlassBrandLogoProps {
  size?: number;
  className?: string;
}

export function GlassBrandLogo({ size = 28, className = '' }: GlassBrandLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="veyricGlassFrame" x1="4" y1="3" x2="32" y2="33" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(255, 255, 255, 0.55)" />
          <stop offset="50%" stopColor="rgba(186, 218, 255, 0.25)" />
          <stop offset="100%" stopColor="rgba(255, 255, 255, 0.08)" />
        </linearGradient>
        <linearGradient id="veyricPrismLeft" x1="8" y1="10" x2="18" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#93C5FD" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="veyricPrismRight" x1="28" y1="10" x2="18" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#DBEAFE" stopOpacity="0.82" />
          <stop offset="100%" stopColor="#60A5FA" stopOpacity="0.38" />
        </linearGradient>
      </defs>
      <rect
        x="1.5"
        y="1.5"
        width="33"
        height="33"
        rx="10"
        fill="rgba(255, 255, 255, 0.06)"
        stroke="url(#veyricGlassFrame)"
        strokeWidth="1.2"
      />
      <path d="M9.5 11L18 26.5L18 19.5L13.5 11H9.5Z" fill="url(#veyricPrismLeft)" />
      <path d="M26.5 11L18 26.5L18 19.5L22.5 11H26.5Z" fill="url(#veyricPrismRight)" />
    </svg>
  );
}
