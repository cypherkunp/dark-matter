import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal skills.sh for e2e (#31): `GET /api/search?q=` over fixed
 * listings, every term must match. The core is pointed here with
 * `DARK_MATTER_SKILLS_SH_API`. The full fake is core/test/fake-skills-sh.ts.
 */
export const startFakeSkillsSh = async (listings: { source: string; skillId: string; installs: number }[]) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const terms = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const skills = listings
      .map((listing) => ({ id: `${listing.source}/${listing.skillId}`, name: listing.skillId, ...listing }))
      .filter((skill) => terms.every((term) => skill.id.toLowerCase().includes(term)));
    res.writeHead(url.pathname === "/api/search" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ query: url.searchParams.get("q"), count: skills.length, skills }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
