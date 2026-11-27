export function PageHead({ title, summary, status }: { title: string; summary: string; status?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-balance font-bold text-[28px] leading-tight tracking-[-0.025em]">{title}</h1>
      <p className="text-muted-foreground text-sm">{summary}</p>
      {status && <p className="text-muted-foreground text-xs">{status}</p>}
    </div>
  );
}
