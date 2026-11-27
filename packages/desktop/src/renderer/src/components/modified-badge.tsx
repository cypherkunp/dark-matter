import { Chip } from "@/components/ui/chip";

/** Modified (#34): changed since it was last Imported, so it no longer matches its Source. */
export function ModifiedBadge() {
  return (
    <Chip
      tone="warning"
      data-testid="modified-badge"
      title="Changed since it was last Imported: it no longer matches its Library Lock hash"
    >
      Modified
    </Chip>
  );
}
