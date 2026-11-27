export function PageHead({ title, summary, status }: { title: string; summary: string; status?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-balance font-bold text-display">{title}</h1>
      <p className="text-lead text-muted-foreground">{summary}</p>
      {status && <p className="text-muted-foreground/80 text-meta">{status}</p>}
    </div>
  );
}
