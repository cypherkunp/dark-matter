import { Dialog } from "@base-ui/react/dialog";
import type { ProjectMcpServer } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { OnOffSwitch } from "@/components/project-skills";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const pill = "rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground";

const deliveryText = ({ agent, file, status }: ProjectMcpServer["deliveries"][number]) =>
  status === "tracked"
    ? `${agentName(agent)}: not offered, ${file} is tracked by git`
    : `${agentName(agent)} ${file}${status === "off" ? " (off)" : ""}`;

function ProjectMcpServerRow({ path, server }: { path: string; server: ProjectMcpServer }) {
  const trpc = useTRPC();
  const setOn = useMutation(trpc.project.setMcpServerOn.mutationOptions());
  const remove = useMutation(trpc.project.removeMcpServer.mutationOptions());
  const busy = setOn.isPending || remove.isPending;
  const error = setOn.error ?? remove.error;
  return (
    <div data-testid="project-mcp-row" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone={server.on ? "on" : "off"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{server.name}</span>
          <span className={pill}>Personal</span>
          {server.secrets.length > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <KeyRound className="size-3" />
              {plural(server.secrets.length, "Secret")}
            </span>
          )}
        </div>
        {server.deliveries.length === 0 ? (
          <p className="text-muted-foreground text-xs">None of this Project's Agents read MCP Servers.</p>
        ) : (
          server.deliveries.map((delivery) => (
            <div
              key={delivery.agent}
              data-testid="project-mcp-delivery"
              className="truncate font-mono text-muted-foreground text-xs"
            >
              {deliveryText(delivery)}
            </div>
          ))
        )}
        {error && <p className="text-status-warning text-xs">{error.message}</p>}
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate({ path, name: server.name })}>
        Remove
      </Button>
      <OnOffSwitch
        on={server.on}
        disabled={busy}
        label={`${server.name} On`}
        onChange={(on) => setOn.mutate({ path, name: server.name, on })}
      />
    </div>
  );
}

/** + Add MCP Servers: Library MCP Servers, added as Personal for the Project's Agents. */
function AddMcpServersDialog({ path, added, onClose }: { path: string; added: string[]; onClose: () => void }) {
  const trpc = useTRPC();
  const library = useQuery(trpc.mcp.list.queryOptions());
  const targets = useQuery(trpc.project.mcpTargets.queryOptions({ path }));
  const [picked, setPicked] = useState<string[]>([]);
  const add = useMutation(trpc.project.addMcpServers.mutationOptions({ onSuccess: onClose }));
  const candidates = (library.data?.servers ?? []).filter(
    (server) => server.definition && !added.includes(server.name),
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(36rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">Add MCP Servers</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">
            Each one is added as Personal: written only where you see it, with its Secrets filled in, and never
            committed.
          </Dialog.Description>
          {(targets.data ?? []).length > 0 && (
            <ul className="flex flex-col gap-1 text-xs">
              {(targets.data ?? []).map((target) => (
                <li key={target.agent} data-testid="mcp-target" className="font-mono text-muted-foreground">
                  {agentName(target.agent)} → {target.file}
                  {!target.personal && " (tracked by git: Personal isn't offered)"}
                </li>
              ))}
            </ul>
          )}
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">Every Library MCP Server is already in this Project.</p>
          ) : (
            <div className="min-h-0 divide-y overflow-y-auto rounded-xl border">
              {candidates.map((server) => (
                <label
                  key={server.name}
                  data-testid="add-mcp-option"
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={picked.includes(server.name)}
                    onChange={() =>
                      setPicked((current) =>
                        current.includes(server.name)
                          ? current.filter((name) => name !== server.name)
                          : [...current, server.name],
                      )
                    }
                  />
                  <span className="text-sm">{server.name}</span>
                  {server.missingSecrets.length > 0 && (
                    <span className="text-status-warning text-xs">
                      {plural(server.missingSecrets.length, "Secret")} to enter first
                    </span>
                  )}
                  <span className={cn(pill, "ml-auto")}>{server.definition?.transport}</span>
                </label>
              ))}
            </div>
          )}
          {add.error && <p className="text-sm text-status-warning">{add.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button
              disabled={picked.length === 0 || add.isPending}
              onClick={() => add.mutate({ servers: picked.map((name) => ({ path, name })) })}
            >
              Add {plural(picked.length, "MCP Server")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Project page's MCP Servers: Personal deliveries per Agent, On/Off and Remove. */
export function ProjectMcpServers({ path }: { path: string }) {
  const trpc = useTRPC();
  const servers = useQuery(trpc.project.mcpServers.queryOptions({ path }));
  const [adding, setAdding] = useState(false);
  const list = servers.data ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-sm">
          MCP Servers
          <span className="font-normal text-muted-foreground text-xs tabular-nums">{list.length}</span>
        </h2>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add MCP Servers
        </Button>
      </div>
      {servers.error && <p className="text-status-warning text-xs">{servers.error.message}</p>}
      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">No Project MCP Servers yet. Add them from the Library.</p>
      ) : (
        <div className="divide-y rounded-xl border">
          {list.map((server) => (
            <ProjectMcpServerRow key={server.name} path={path} server={server} />
          ))}
        </div>
      )}
      {adding && (
        <AddMcpServersDialog path={path} added={list.map((server) => server.name)} onClose={() => setAdding(false)} />
      )}
    </section>
  );
}
