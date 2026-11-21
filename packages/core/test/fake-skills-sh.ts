import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/** One skills.sh listing as `/api/search` returns it. */
export interface FakeListing {
  source: string;
  skillId: string;
  name?: string;
  installs?: number;
}

/**
 * A fake skills.sh at the HTTP level: `GET /api/search?q=&limit=` answers
 * like the public endpoint (#4): every term must match, 2+ characters, and a
 * 429 with `Retry-After: 60` while `rateLimited` is set.
 */
export const fakeSkillsSh = async (listings: FakeListing[] = []) => {
  const requests: string[] = [];
  const state = { rateLimited: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(url.pathname + url.search);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== "/api/search") return send(404, { error: "not_found" });
    if (state.rateLimited) {
      return send(
        429,
        {
          error: "rate_limit_exceeded",
          message: "Rate limit exceeded. Maximum 30 requests per minute.",
        },
        { "retry-after": "60" },
      );
    }
    const query = url.searchParams.get("q") ?? "";
    if (query.length < 2) return send(400, { error: "Query must be at least 2 characters" });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const skills = listings
      .map((listing) => ({
        id: `${listing.source}/${listing.skillId}`,
        source: listing.source,
        skillId: listing.skillId,
        name: listing.name ?? listing.skillId,
        installs: listing.installs ?? 0,
      }))
      .filter((skill) => terms.every((term) => `${skill.id} ${skill.name}`.toLowerCase().includes(term)))
      .slice(0, limit);
    send(200, { query, searchType: "fuzzy", count: skills.length, skills });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    /** The base URL to boot the core with. */
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listings,
    /** Every request's path and query. */
    requests,
    set rateLimited(value: boolean) {
      state.rateLimited = value;
    },
  };
};
