export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Mimir" role="img">
      <circle cx="32" cy="32" r="8" fill="#36e2c4" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="#36e2c4" strokeOpacity="0.55" strokeWidth="4" />
      <circle cx="32" cy="32" r="27" fill="none" stroke="#36e2c4" strokeOpacity="0.25" strokeWidth="4" />
    </svg>
  );
}
