import { operationPolicy } from "@dark-matter/contracts/policy";
import { type CoreServices, createAppRouter } from "@dark-matter/contracts/router";
import { describe, expect, test } from "vitest";

/** Every procedure the router serves, by path, with its tRPC type. */
const procedures = () => {
  const router = createAppRouter({} as CoreServices);
  return Object.entries(router._def.procedures as unknown as Record<string, { _def: { type: string } }>).map(
    ([path, procedure]) => ({ path, type: procedure._def.type }),
  );
};

describe("the policy table (ADR-0006)", () => {
  test("classifies every mutation as a read, requestable or app-only, and nothing that isn't one", () => {
    const mutations = procedures()
      .filter((procedure) => procedure.type === "mutation")
      .map((procedure) => procedure.path)
      .sort();

    expect(mutations.filter((path) => !(path in operationPolicy))).toEqual([]);
    expect(Object.keys(operationPolicy).sort()).toEqual(mutations);
  });

  test("an Agent can request exactly the changes the ADR lists", () => {
    const requestable = Object.entries(operationPolicy)
      .filter(([, policy]) => policy.kind === "requestable")
      .map(([path]) => path)
      .sort();

    expect(requestable).toEqual([
      "importer.import",
      "project.addMcpServers",
      "project.addSkills",
      "project.removeMcpServer",
      "project.removeSkill",
      "project.setMcpServerOn",
      "project.setSkillOn",
    ]);
  });

  test("Adopt, Detach, deleting, editing contents, Modified choices, Secrets, settings and confirming Projects are app-only", () => {
    for (const path of [
      "adopt.execute",
      "adopt.undo",
      "skill.delete",
      "skill.saveFile",
      "project.updateCopy",
      "project.pullCopy",
      "mcp.setSecret",
      "mcp.deleteSecret",
      "importer.setToken",
      "settings.updatePreferences",
      "project.add",
      "project.setGrant",
      "requests.approve",
      "requests.deny",
    ]) {
      expect(operationPolicy[path as keyof typeof operationPolicy]?.kind, path).toBe("appOnly");
    }
  });
});
