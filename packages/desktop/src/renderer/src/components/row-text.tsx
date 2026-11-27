import type { ReactNode } from "react";

/**
 * The text column of a list row: a title with its chips, then one muted line
 * (description first, identifier after a `·` in small monospace), then any
 * notes that ask for action (reasons, errors) on their own lines.
 */
export function RowText({
  title,
  chips,
  description,
  detail,
  children,
}: {
  title: ReactNode;
  chips?: ReactNode | undefined;
  description?: ReactNode | undefined;
  detail?: ReactNode | undefined;
  children?: ReactNode | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-body">{title}</span>
        {chips}
      </div>
      {(description || detail) && (
        <p className="truncate text-meta text-muted-foreground">
          {description}
          {description && detail && <span aria-hidden> · </span>}
          {detail && <span className="font-mono text-micro text-muted-foreground/80">{detail}</span>}
        </p>
      )}
      {children}
    </div>
  );
}
