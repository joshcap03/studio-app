export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" className="fill-inverse" />
      <path d="M16 8.5 23.5 16 16 23.5 8.5 16Z" fill="none" className="stroke-on-inverse" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
