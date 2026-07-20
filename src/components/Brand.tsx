export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Atoms Demo">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && <span>Atoms Demo</span>}
    </div>
  );
}
