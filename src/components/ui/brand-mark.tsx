export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" className="fill-inverse" />
      <path
        d="M11 9v12.5h5.5M21 9v9.5a3 3 0 0 1-3 3"
        fill="none"
        className="stroke-on-inverse"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
