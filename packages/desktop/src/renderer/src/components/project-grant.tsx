import type { ProjectDetail } from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { OnOffSwitch } from "@/components/project-skills";
import { useTRPC } from "@/lib/trpc";

/**
 * The Project's Grant (ADR-0006, #44): off by default and revocable. While on,
 * Agents' Requests to turn things On or Off and to add or remove a Link here go
 * through without asking. A Copy, an MCP Server and an Import always ask.
 */
export function ProjectGrant({ project }: { project: ProjectDetail }) {
  const trpc = useTRPC();
  const setGrant = useMutation(trpc.project.setGrant.mutationOptions());
  const on = setGrant.isPending ? (setGrant.variables?.grant ?? false) : (project.grant ?? false);
  return (
    <section data-testid="project-grant" className="flex items-center gap-4 rounded-xl border px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-sm">Let Agents make low-risk changes without asking</span>
        <p className="text-muted-foreground text-xs">
          Turning Skills and MCP Servers On or Off, and adding or removing a Link. A Copy, an MCP Server or an Import
          still asks you every time.
        </p>
        {setGrant.error && <p className="text-destructive text-xs">{setGrant.error.message}</p>}
      </div>
      <OnOffSwitch
        on={on}
        disabled={setGrant.isPending}
        label="Grant"
        onChange={(grant) => setGrant.mutate({ path: project.path, grant })}
      />
    </section>
  );
}
