import type { ProjectDetail } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "@/components/copy-actions";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";

const code = "font-mono text-xs";

/**
 * Remove a Project (review #5): shows the plan first. Dark Matter's own
 * deliveries go (Links, Personal MCP entries); committed ones stay in the repo
 * for the team, and the dialog says so.
 */
export function RemoveProjectButton({ project }: { project: ProjectDetail }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const plan = useQuery({
    ...trpc.project.removePlan.queryOptions({ path: project.path }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const remove = useMutation(trpc.project.remove.mutationOptions({ onSuccess: () => navigate({ to: "/library" }) }));
  const data = plan.data;
  return (
    <>
      <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => setOpen(true)}>
        Remove
      </Button>
      {open && (
        <ConfirmDialog
          title={`Remove ${project.name}?`}
          confirm="Remove Project"
          busy={remove.isPending || !data}
          error={(plan.error ?? remove.error)?.message}
          onConfirm={() => remove.mutate({ path: project.path })}
          onClose={() => setOpen(false)}
        >
          <div data-testid="remove-project-plan" className="flex flex-col gap-2">
            <p>Dark Matter forgets this Project and removes what it delivered there for you alone:</p>
            {data && data.links.length === 0 && data.personalMcpServers.length === 0 && <p>Nothing to remove.</p>}
            <ul className="list-disc pl-5">
              {data?.links.map((link) => (
                <li key={link}>
                  Link <code className={code}>{link}</code>
                </li>
              ))}
              {data?.personalMcpServers.map((entry) => (
                <li key={`${entry.name}:${entry.file}`}>
                  Personal MCP Server <code className={code}>{entry.name}</code> in{" "}
                  <code className={code}>{entry.file}</code>
                </li>
              ))}
            </ul>
            {data && (data.keptCopies.length > 0 || data.keptSharedMcpServers.length > 0) && (
              <>
                <p>
                  These are committed for your team, so they stay in the repo (Vendored from now on). Delete them in git
                  if the team no longer needs them:
                </p>
                <ul className="list-disc pl-5">
                  {data.keptCopies.map((copy) => (
                    <li key={copy}>
                      Copy <code className={code}>{copy}</code>
                    </li>
                  ))}
                  {data.keptSharedMcpServers.map((entry) => (
                    <li key={`${entry.name}:${entry.file}`}>
                      Shared MCP Server <code className={code}>{entry.name}</code> in{" "}
                      <code className={code}>{entry.file}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
