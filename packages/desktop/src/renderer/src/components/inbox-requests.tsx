import type { AgentId, PendingRequest, RequestReason } from "@dark-matter/contracts";
import { useMutation } from "@tanstack/react-query";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";
import { relativeTime, useNow } from "@/lib/use-now";

/** Why a Request asks instead of going through on a Grant, in words. */
const reasonLabels: Record<RequestReason, string> = {
  noGrant: "No Grant for this Project",
  copy: "A Copy is a committed team change",
  sharedMcpServer: "A Shared MCP Server is a committed team change",
  mcpServer: "An MCP Server runs code",
  import: "An Import fetches from the network",
  discardEdits: "It discards edits in the repo",
};

/** Who asked: the Agent by name when it gave one, else the client. */
const requester = (request: PendingRequest) =>
  request.agent
    ? (agentName(request.agent as AgentId) ?? request.agent)
    : request.client === "cli"
      ? "The dm CLI"
      : "An Agent";

function RequestRow({ request }: { request: PendingRequest }) {
  const trpc = useTRPC();
  const now = useNow();
  const approve = useMutation(trpc.requests.approve.mutationOptions());
  const deny = useMutation(trpc.requests.deny.mutationOptions());
  const busy = approve.isPending || deny.isPending;
  const failed = approve.data?.status === "failed" ? approve.data.error?.message : null;
  const error = failed ?? approve.error?.message ?? deny.error?.message;
  return (
    <div data-testid="inbox-request" className="flex min-h-16 items-center gap-3 px-5 py-3">
      <StatusDot tone="warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-body">{request.summary}</span>
        <p className="text-muted-foreground text-meta">
          {requester(request)} asked {relativeTime(Date.parse(request.createdAt), now)} ·{" "}
          {request.reasons.map((reason) => reasonLabels[reason]).join(" · ")}
        </p>
        {error && <p className="text-status-warning text-meta">{error}</p>}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => deny.mutate({ id: request.id })}>
          Deny
        </Button>
        <Button size="sm" disabled={busy} onClick={() => approve.mutate({ id: request.id })}>
          Approve
        </Button>
      </div>
    </div>
  );
}

/** Pending Requests from Agents and the CLI, with Approve or Deny (ADR-0006, #44). */
export function InboxRequests({ requests }: { requests: PendingRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-heading">Requests</h2>
        <p className="text-muted-foreground text-body">
          Changes Agents asked to make. Approving re-checks each against the Project as it is now; a Request expires
          after 24 hours.
        </p>
      </div>
      <div className="divide-y rounded-xl border">
        {requests.map((request) => (
          <RequestRow key={request.id} request={request} />
        ))}
      </div>
    </section>
  );
}
