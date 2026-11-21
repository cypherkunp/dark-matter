export function PageHead({ title, summary, status }: { title: string; summary: string; status?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm">{summary}</p>
      {status && <p className="text-muted-foreground text-xs">{status}</p>}
    </div>
  );
}
