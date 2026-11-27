import { type AgentId, type InventoryGroup, type InventoryItem, readOnlyReasonText } from "@dark-matter/contracts";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { agentName } from "@/lib/agents";
import { useTRPC } from "@/lib/trpc";

const kindLabel: Record<InventoryItem["kind"], string> = {
  globalSkill: "Global Skill",
  untrackedSkill: "Untracked Project Skill",
  vendoredSkill: "Vendored Skill",
  managedSkill: "Agent-managed Skill",
  globalMcpServer: "Global MCP Server",
  managedMcpServer: "Agent-managed MCP Server",
};

const agentList = (agents: readonly AgentId[]) => agents.map((agent) => agentName(agent)).join(", ");

function Row({ item, owner }: { item: InventoryItem; owner: AgentId }) {
  return (
    <div data-testid="inventory-item" data-kind={item.kind} className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-medium text-body">{item.name}</span>
        <span className="rounded-md border px-1.5 py-0.5 font-mono text-micro text-muted-foreground">
          {kindLabel[item.kind]}
        </span>
        {item.off && <span className="text-muted-foreground text-meta">Off</span>}
        {item.readOnlyReason && (
          <span
            data-testid="inventory-read-only"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-micro text-muted-foreground"
          >
            <Lock className="size-3" />
            Read-only
          </span>
        )}
      </div>
      {item.detail && <p className="truncate text-muted-foreground text-meta">{item.detail}</p>}
      <p data-testid="inventory-agents" className="text-muted-foreground text-meta">
        Seen by {agentList(item.agents)}
      </p>
      {item.readOnlyReason && (
        <p data-testid="inventory-reason" className="text-muted-foreground text-meta">
          {readOnlyReasonText(item.readOnlyReason, owner)}
        </p>
      )}
    </div>
  );
}

function Group({ group }: { group: InventoryGroup }) {
  return (
    <section data-testid="inventory-group" data-folder={group.label} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="font-mono font-semibold text-body">{group.label}</h3>
        <span className="text-muted-foreground text-meta">
          {group.scope === "managed"
            ? `Managed by ${agentName(group.owningAgent)}`
            : `Owned by ${agentName(group.owningAgent)}`}{" "}
          · read by {agentList(group.agents)}
        </span>
      </div>
      <div className="divide-y rounded-xl border">
        {group.items.map((item) => (
          <Row key={item.id} item={item} owner={group.owningAgent} />
        ))}
      </div>
    </section>
  );
}

/**
 * Everything the latest Scan found (#55), grouped by owning folder with
 * `.agents` first: each item with the Agents that see it, and a read-only
 * badge with the reason when it can't be adopted. Shared by First run's Found
 * step and Computer › Agents.
 */
export function Inventory({ empty = "Nothing found outside the Library." }: { empty?: string }) {
  const trpc = useTRPC();
  const inventory = useQuery(trpc.agents.inventory.queryOptions());
  if (inventory.isPending) return null;
  if (inventory.error) return <p className="text-body text-status-warning">{inventory.error.message}</p>;
  const { groups } = inventory.data;
  if (groups.length === 0) return <p className="text-muted-foreground text-body">{empty}</p>;
  return (
    <div data-testid="inventory" className="flex flex-col gap-5">
      {groups.map((group) => (
        <Group key={group.id} group={group} />
      ))}
    </div>
  );
}
