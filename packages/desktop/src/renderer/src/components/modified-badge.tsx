/** Modified (#34): changed since it was last Imported, so it no longer matches its Source. */
export function ModifiedBadge() {
  return (
    <span
      data-testid="modified-badge"
      title="Changed since it was last Imported: it no longer matches its Library Lock hash"
      className="rounded-full bg-warning-surface px-2 py-0.5 font-medium text-[11px] text-status-warning"
    >
      Modified
    </span>
  );
}
