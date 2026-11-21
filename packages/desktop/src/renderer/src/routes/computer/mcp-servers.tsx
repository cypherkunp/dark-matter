// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shows the MCP reference syntax, not a template.
import { Dialog } from "@base-ui/react/dialog";
import { type LibraryMcpServer, McpDefinition } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Server } from "lucide-react";
import { useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import { ConfirmDialog } from "@/components/copy-actions";
import { definitionSummary } from "@/components/inbox-mcp";
import { byAgent, ManagedMcpGroups } from "@/components/managed-mcp";
import { PageHead } from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/computer/mcp-servers")({ component: McpServers });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One Secret: enter it when it's missing, or rotate it. The value goes straight
 * to the keychain, and Personal deliveries that use it are rewritten.
 */
function SecretField({ name, missing }: { name: string; missing: boolean }) {
  const trpc = useTRPC();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [value, setValue] = useState("");
  const remove = useMutation(trpc.mcp.deleteSecret.mutationOptions({ onSuccess: () => setDeleting(false) }));
  const save = useMutation(
    trpc.mcp.setSecret.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        setValue("");
      },
    }),
  );
  return (
    <div data-testid="mcp-secret" className="flex items-center gap-2 text-muted-foreground text-xs">
      <KeyRound className="size-3" />
      <span className="font-mono">{name}</span>
      {missing && <span className="text-status-warning">not in the keychain</span>}
      {editing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (value) save.mutate({ name, value });
          }}
        >
          <input
            type="password"
            aria-label={`Value of ${name}`}
            autoComplete="off"
            className="h-6 w-48 rounded-md border bg-background px-2 font-mono text-foreground text-xs"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={!value || save.isPending}>
            Save
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {missing ? "Enter" : "Rotate"}
          </Button>
          {!missing && (
            <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
              Delete
            </Button>
          )}
        </>
      )}
      {save.error && <span className="text-status-warning">{save.error.message}</span>}
      {deleting && (
        <ConfirmDialog
          title={`Delete the Secret ${name}?`}
          confirm="Delete Secret"
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate({ name })}
          onClose={() => {
            remove.reset();
            setDeleting(false);
          }}
        >
          <p>
            Its value is removed from the keychain. Definitions keep referring to it by name, so you can enter it again
            later. A Secret that On Personal deliveries still use can't be deleted.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Edits a Library MCP Server's definition as JSON. Saving rewrites its Personal
 * deliveries straight away and marks Shared ones outdated, per Project.
 */
function EditDefinitionDialog({ server, onClose }: { server: LibraryMcpServer; onClose: () => void }) {
  const trpc = useTRPC();
  const initial = `${JSON.stringify(server.definition, null, 2)}\n`;
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation(trpc.mcp.updateDefinition.mutationOptions({ onSuccess: onClose }));
  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    const definition = McpDefinition.safeParse(parsed);
    if (!definition.success) {
      setProblem(definition.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    setProblem(null);
    save.mutate({ name: server.name, definition: definition.data });
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/30" />
        <Dialog.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 flex max-h-[85vh] w-[min(42rem,calc(100vw-4rem))] flex-col gap-4 rounded-xl border bg-background p-6">
          <Dialog.Title className="font-semibold text-lg">Edit {server.name}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">
            Refer to Secrets as <span className="font-mono">{"${secret:NAME}"}</span> and to env vars as{" "}
            <span className="font-mono">{"${env:VAR}"}</span>. Saving rewrites Personal deliveries now; Shared ones show
            as outdated until you update each Project.
          </Dialog.Description>
          <div data-testid="mcp-definition-editor" className="min-h-48 overflow-auto rounded-xl border">
            <CodeEditor path={`${server.name}.json`} initial={initial} onChange={setText} onSave={submit} />
          </div>
          {(problem ?? save.error?.message) && (
            <p className="text-sm text-status-warning">{problem ?? save.error?.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>Cancel</Dialog.Close>
            <Button disabled={save.isPending} onClick={submit}>
              Save
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ServerRow({ server }: { server: LibraryMcpServer }) {
  const trpc = useTRPC();
  const undo = useMutation(trpc.mcp.undoAdopt.mutationOptions());
  const [editing, setEditing] = useState(false);
  const origins = server.adoptedFrom.map((origin) => `${agentName(origin.agent)} ${origin.file}`).join(", ");
  return (
    <div data-testid="library-mcp-server" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{server.name}</span>
          {server.definition && (
            <span className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {server.definition.transport}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {server.definition ? definitionSummary(server.definition) : server.file}
        </div>
        {server.secrets.map((secret) => (
          <SecretField key={secret} name={secret} missing={server.missingSecrets.includes(secret)} />
        ))}
        {server.problem && <p className="text-status-warning text-xs">{server.problem}</p>}
        {undo.error && <p className="text-status-warning text-xs">{undo.error.message}</p>}
      </div>
      {server.definition && (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
      )}
      {editing && <EditDefinitionDialog server={server} onClose={() => setEditing(false)} />}
      {server.adoptedFrom.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          title={`Put it back into ${origins}`}
          disabled={undo.isPending}
          onClick={() => undo.mutate({ name: server.name })}
        >
          Undo Adopt
        </Button>
      )}
    </div>
  );
}

/** Library MCP Servers: Agent-neutral definitions under `~/.dark-matter/mcp/`. */
function McpServers() {
  const trpc = useTRPC();
  const list = useQuery(trpc.mcp.list.queryOptions());
  const managed = useQuery(trpc.agents.managedMcp.queryOptions());
  const servers = list.data?.servers ?? [];
  const secrets = new Set(servers.flatMap((server) => server.secrets)).size;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead
        title="MCP Servers"
        summary={`${plural(servers.length, "MCP Server")} · ${plural(secrets, "Secret")}`}
        status="Library definitions in ~/.dark-matter/mcp, Secrets in the keychain"
      />
      {list.isPending ? null : servers.length === 0 ? (
        <section
          data-testid="mcp-empty"
          className="flex flex-col items-center gap-3 rounded-xl border px-6 py-16 text-center"
        >
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Server className="size-5 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-base">No MCP Servers in the Library</h2>
          <p className="max-w-sm text-muted-foreground text-sm">
            A Scan lists the MCP Servers in each Agent's global config in the Inbox. Adopt them to define each one once
            here.
          </p>
        </section>
      ) : (
        <div className="divide-y rounded-xl border">
          {servers.map((server) => (
            <ServerRow key={server.name} server={server} />
          ))}
        </div>
      )}
      <ManagedMcpGroups groups={byAgent(managed.data ?? [])} />
    </div>
  );
}
