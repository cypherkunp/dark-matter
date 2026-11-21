import type { SkillDetail } from "@dark-matter/contracts";
import { TriangleAlert } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Tailwind classes for rendered Markdown (no typography plugin): compact, like the rest of the app. */
export const markdownComponents: Components = {
  h1: (props) => <h1 className="mt-6 mb-3 font-semibold text-xl tracking-tight first:mt-0" {...props} />,
  h2: (props) => <h2 className="mt-6 mb-2 font-semibold text-lg first:mt-0" {...props} />,
  h3: (props) => <h3 className="mt-5 mb-2 font-semibold text-base first:mt-0" {...props} />,
  h4: (props) => <h4 className="mt-4 mb-1.5 font-semibold text-sm" {...props} />,
  p: (props) => <p className="my-3 leading-relaxed" {...props} />,
  ul: (props) => <ul className="my-3 list-disc space-y-1 pl-6" {...props} />,
  ol: (props) => <ol className="my-3 list-decimal space-y-1 pl-6" {...props} />,
  a: ({ href, ...props }) => (
    // Read-only preview: show where a link goes, never navigate the app window away.
    <a className="text-status-on underline-offset-2 hover:underline" title={href} {...props} />
  ),
  blockquote: (props) => <blockquote className="my-3 border-l-2 pl-4 text-muted-foreground" {...props} />,
  code: ({ className, ...props }) => (
    <code className={className ?? "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"} {...props} />
  ),
  pre: (props) => (
    <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-relaxed" {...props} />
  ),
  table: (props) => <table className="my-3 w-full border-collapse text-left text-[13px]" {...props} />,
  th: (props) => <th className="border-b px-2 py-1.5 font-medium" {...props} />,
  td: (props) => <td className="border-b px-2 py-1.5 align-top" {...props} />,
  hr: () => <hr className="my-6" />,
};

/** The Preview tab: SKILL.md read-only, the way an Agent sees it, under its validated frontmatter. */
export function SkillPreview({ skill }: { skill: SkillDetail }) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <section data-testid="skill-frontmatter" className="overflow-hidden rounded-xl border">
        <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 font-medium text-muted-foreground text-xs">
          Frontmatter
          {skill.warnings.length === 0 && skill.frontmatter !== null && (
            <span className="ml-auto text-status-healthy">valid</span>
          )}
        </div>
        <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[12px] leading-relaxed">
          {skill.frontmatter ?? "(none)"}
        </pre>
        {skill.warnings.length > 0 && (
          <ul
            data-testid="frontmatter-warnings"
            className="flex flex-col gap-1.5 border-warning-border border-t bg-warning-surface px-4 py-3 text-[13px]"
          >
            {skill.warnings.map((warning) => (
              <li key={warning.message} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
                <span>{warning.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <article data-testid="skill-markdown" className="text-sm">
        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {skill.body}
        </Markdown>
      </article>
    </div>
  );
}
