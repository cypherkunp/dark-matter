import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  type ActivitySubject,
  AppOnly,
  type ClientKind,
  isTaggedError,
  ProjectNotFound,
  type ProjectsFile,
  RequestDecided,
  RequestDenied,
  RequestExpired,
  RequestNotFound,
  RequestPending,
  type RequestReason,
  type RequestRecord,
  type RequestStatus,
  type RequestsFile,
} from "@dark-matter/contracts";
import { policyFor, type RequestCategory } from "@dark-matter/contracts/policy";
import type { GuardedCall } from "@dark-matter/contracts/router";
import type { ActivityLog } from "./activity";
import { runAs } from "./caller";
import type { Clock } from "./clock";
import type { EventBus } from "./events";
import type { Notifier } from "./notifier";
import type { OwnedFile } from "./owned-file";

/** A pending Request expires after this long, and a decided one is forgotten this long after its decision. */
const REQUEST_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** How long an Agent's call waits for Approve or Deny before it's told the Request is pending. */
export const DEFAULT_REQUEST_WAIT_MS = 60_000;

/** Applies an approved Request by calling its mutation again, as the requesting client. */
export type RequestApplier = (request: RequestRecord) => Promise<unknown>;

export interface RequestsOptions {
  file: OwnedFile<typeof RequestsFile>;
  projects: OwnedFile<typeof ProjectsFile>;
  activity: ActivityLog;
  clock: Clock;
  notifier: Notifier;
  bus: EventBus;
  waitMs: number;
}

/** What a requestable change does, read from its validated input. */
interface Change {
  projects: string[];
  summary: string;
  reasons: RequestReason[];
}

type Decision = "approve" | "deny";

interface Waiter {
  decide(decision: Decision): void;
  /** Settles with the Request once the waiting call has applied (or failed to apply) it. */
  done: Promise<RequestRecord>;
  finish(request: RequestRecord): void;
}

const modeName = (mode: string | undefined) => (mode === "copy" ? "Copy" : "Link");

/**
 * Consent for clients other than the app (ADR-0006): the one policy check every
 * mutation passes, and the Requests it makes. A Request lives in `requests.json`,
 * waits about a minute for Approve or Deny in the app, then stays pending in the
 * Inbox until you decide or it expires after 24 hours. Applying one re-runs its
 * mutation against the current state, so it's re-validated then.
 */
export class Requests {
  readonly #options: RequestsOptions;
  readonly #waiters = new Map<string, Waiter>();
  #applier: RequestApplier | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RequestsOptions) {
    this.#options = options;
  }

  /** The server hands in how to call a mutation once its router exists. */
  setApplier(applier: RequestApplier): void {
    this.#applier = applier;
  }

  /** The policy check: runs `next`, turns the call into a Request, or refuses it. */
  async consent<T>(call: GuardedCall, next: () => Promise<T>): Promise<T> {
    if (call.approved !== undefined) return runAs({ agent: call.agent, request: call.approved }, next);
    if (call.client === "app") return next();
    const policy = policyFor(call.path);
    if (policy.kind === "appOnly") throw new AppOnly(call.path);
    if (policy.kind === "read") return runAs({ agent: call.agent }, next);
    const input = policy.input.safeParse(call.input);
    // Invalid input fails validation in the procedure itself, with the usual error.
    if (!input.success) return next();
    const change = this.#change(policy.category, input.data);
    for (const path of change.projects) {
      if (!this.#options.projects.value.projects[path]) throw new ProjectNotFound(path);
    }
    if (change.reasons.length === 0) return runAs({ agent: call.agent }, next);

    const request = await this.#create(call, change);
    if (this.#options.notifier.available?.() === false) throw new RequestPending(request);
    const decision = await this.#wait(request.id);
    if (decision === null) throw new RequestPending(request);
    if (decision === "deny") throw new RequestDenied(request.id);
    return this.#apply(request.id, () => runAs({ agent: call.agent, request: request.id }, next));
  }

  list(): RequestRecord[] {
    return Object.values(this.#options.file.value.requests).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }

  /** Pending Requests, oldest first, for the Inbox. */
  pending(): RequestRecord[] {
    return this.list()
      .filter((request) => request.status === "pending")
      .reverse();
  }

  get(id: string): RequestRecord {
    const request = this.#options.file.value.requests[id];
    if (!request) throw new RequestNotFound(id);
    return request;
  }

  async approve(id: string, _client: ClientKind): Promise<RequestRecord> {
    const request = await this.#decide(id, "approve");
    const waiter = this.#waiters.get(id);
    if (waiter) {
      waiter.decide("approve");
      return waiter.done;
    }
    const applier = this.#applier;
    if (!applier) throw new Error("The core can't apply Requests yet");
    try {
      await this.#apply(id, () => applier(request));
    } catch {
      // Recorded on the Request (failed, with the error) and in the Activity Log.
    }
    return this.get(id);
  }

  async deny(id: string, _client: ClientKind): Promise<RequestRecord> {
    await this.#decide(id, "deny");
    const denied = await this.#settle(id, "denied");
    this.#waiters.get(id)?.decide("deny");
    this.#finish(id, denied);
    return denied;
  }

  /**
   * Expires pending Requests 24 hours old (recorded in the Activity Log) and
   * forgets decided ones 24 hours after their decision. Runs on start and every minute.
   */
  async expire(): Promise<void> {
    const now = this.#options.clock.now().getTime();
    const due = (iso: string) => new Date(iso).getTime() + REQUEST_LIFETIME_MS <= now;
    for (const request of this.list()) {
      if (request.status === "pending" && new Date(request.expiresAt).getTime() <= now) {
        await this.#settle(request.id, "expired");
      }
    }
    const forget = this.list().filter(
      (request) => request.status !== "pending" && due(request.decidedAt ?? request.createdAt),
    );
    if (forget.length > 0) {
      await this.#save((requests) => {
        for (const request of forget) delete requests[request.id];
      });
    }
  }

  async #create(call: GuardedCall, change: Change): Promise<RequestRecord> {
    const now = this.#options.clock.now();
    const request: RequestRecord = {
      id: randomUUID(),
      client: call.client,
      ...(call.agent !== undefined && { agent: call.agent }),
      operation: call.path,
      input: call.input,
      projects: change.projects,
      summary: change.summary,
      reasons: change.reasons,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REQUEST_LIFETIME_MS).toISOString(),
      status: "pending",
    };
    const file = await this.#save((requests) => {
      requests[request.id] = request;
    });
    await this.#record(request, "request.create", file);
    const who = request.agent ?? (request.client === "cli" ? "The dm CLI" : "An Agent");
    const where = change.projects.length > 0 ? change.projects.map((path) => basename(path)).join(", ") : "the Library";
    this.#options.notifier.notify({
      title: `${who} asks to change ${where}`,
      body: request.summary,
      path: "/inbox",
      request: request.id,
    });
    return request;
  }

  /** Waits for a decision, or `null` after the wait. */
  #wait(id: string): Promise<Decision | null> {
    return new Promise((resolve) => {
      let finish: (request: RequestRecord) => void = () => {};
      const done = new Promise<RequestRecord>((settle) => {
        finish = settle;
      });
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        resolve(null);
      }, this.#options.waitMs);
      this.#waiters.set(id, {
        decide: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
        done,
        finish,
      });
    });
  }

  /** Checks the Request is still pending and not expired, and records your decision. */
  async #decide(id: string, decision: Decision): Promise<RequestRecord> {
    const request = this.get(id);
    if (request.status !== "pending") throw new RequestDecided(id, request.status);
    if (new Date(request.expiresAt).getTime() <= this.#options.clock.now().getTime()) {
      await this.#settle(id, "expired");
      throw new RequestExpired(id);
    }
    await this.#record(request, decision === "approve" ? "request.approve" : "request.deny", null);
    return request;
  }

  /** Runs the Request's mutation and records how it went on the Request. */
  async #apply<T>(id: string, run: () => Promise<T>): Promise<T> {
    try {
      const value = await run();
      this.#finish(id, await this.#settle(id, "applied"));
      return value;
    } catch (error) {
      // Applied through the router, the tagged error is the cause of a tRPC error.
      const cause = isTaggedError(error) ? error : (error as { cause?: unknown } | null)?.cause;
      const reason = isTaggedError(cause) ? cause : error;
      this.#finish(
        id,
        await this.#settle(id, "failed", {
          tag: isTaggedError(reason) ? reason._tag : null,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
      throw error;
    }
  }

  #finish(id: string, request: RequestRecord) {
    const waiter = this.#waiters.get(id);
    this.#waiters.delete(id);
    waiter?.finish(request);
  }

  async #settle(id: string, status: RequestStatus, error?: RequestRecord["error"]): Promise<RequestRecord> {
    const decidedAt = this.#options.clock.now().toISOString();
    const file = await this.#save((requests) => {
      const request = requests[id];
      if (request) requests[id] = { ...request, status, decidedAt, ...(error && { error }) };
    });
    const request = this.get(id);
    if (status === "expired") await this.#record(request, "request.expire", file);
    return request;
  }

  async #save(change: (requests: Record<string, RequestRecord>) => void): Promise<string | null> {
    const run = this.#queue.then(() =>
      this.#options.file.update((current) => {
        const requests = { ...current.requests };
        change(requests);
        return { requests };
      }),
    );
    this.#queue = run.catch(() => {});
    const written = await run;
    this.#options.bus.publish({ type: "invalidate", domains: ["requests", "inbox"] });
    return written;
  }

  /** Request entries go to the Activity Log under the requesting client and Agent. */
  async #record(request: RequestRecord, action: string, file: string | null) {
    const subjects: ActivitySubject[] = [
      { kind: "request", id: request.id },
      ...request.projects.map((path) => ({ kind: "project" as const, id: path })),
    ];
    await runAs({ agent: request.agent, request: request.id }, () =>
      this.#options.activity.record({
        client: request.client,
        action,
        subjects,
        result: "ok",
        filesWritten: file ? [file] : [],
      }),
    );
  }

  /** The Projects a change touches, its plan in words, and why it has to ask. */
  #change(category: RequestCategory, input: unknown): Change {
    const projects = this.#options.projects.value.projects;
    const name = (path: string) => basename(path);
    const granted = (paths: string[]) => paths.every((path) => projects[path]?.grant === true);
    const reasons = (paths: string[], always: (RequestReason | false | undefined)[]): RequestReason[] => [
      ...(granted(paths) ? [] : (["noGrant"] as const)),
      ...always.filter((reason): reason is RequestReason => typeof reason === "string"),
    ];
    const unique = (paths: string[]) => [...new Set(paths)];
    switch (category) {
      case "skill.add": {
        const { skills } = input as { skills: { path: string; key: string; mode?: string }[] };
        const paths = unique(skills.map((skill) => skill.path));
        // Classify on the mode the Project Skill will actually have (a call without
        // one keeps the current mode) and on how it's delivered now: anything that
        // writes or deletes a Copy is a committed team change.
        const planned = skills.map((skill) => {
          const current = projects[skill.path]?.skills[skill.key]?.mode;
          const mode = skill.mode ?? current ?? "link";
          const summary =
            current !== undefined && current !== mode
              ? `Switch ${skill.key} in ${name(skill.path)} from a ${modeName(current)} to a ${modeName(mode)}`
              : `Add ${skill.key} to ${name(skill.path)} as a ${modeName(mode)}`;
          return { touchesCopy: mode === "copy" || current === "copy", summary };
        });
        return {
          projects: paths,
          summary: planned.map((skill) => skill.summary).join("; "),
          reasons: reasons(paths, [planned.some((skill) => skill.touchesCopy) && "copy"]),
        };
      }
      case "skill.remove":
      case "skill.onOff": {
        const { path, key, on, discardEdits } = input as {
          path: string;
          key: string;
          on?: boolean;
          discardEdits?: boolean;
        };
        const mode = projects[path]?.skills[key]?.mode;
        return {
          projects: [path],
          summary:
            category === "skill.remove"
              ? `Remove ${key} from ${name(path)}`
              : `Turn ${key} ${on ? "On" : "Off"} in ${name(path)}`,
          reasons: reasons([path], [mode === "copy" && "copy", discardEdits === true && "discardEdits"]),
        };
      }
      case "mcpServer.add": {
        const { servers } = input as { servers: { path: string; name: string; mode?: string }[] };
        const paths = unique(servers.map((server) => server.path));
        // Like Skills: a call without a mode keeps the current one.
        const planned = servers.map((server) => {
          const current = projects[server.path]?.mcpServers?.[server.name]?.mode;
          const mode = server.mode ?? current ?? "personal";
          return { ...server, current, mode };
        });
        return {
          projects: paths,
          summary: planned
            .map(
              (server) =>
                `Add the MCP Server ${server.name} to ${name(server.path)} as ${server.mode === "shared" ? "Shared" : "Personal"}`,
            )
            .join("; "),
          reasons: reasons(paths, [
            "mcpServer",
            planned.some((server) => server.mode === "shared" || server.current === "shared") && "sharedMcpServer",
          ]),
        };
      }
      case "mcpServer.remove":
      case "mcpServer.onOff": {
        const {
          path,
          name: server,
          on,
          discardEdits,
        } = input as { path: string; name: string; on?: boolean; discardEdits?: boolean };
        const mode = projects[path]?.mcpServers?.[server]?.mode;
        return {
          projects: [path],
          summary:
            category === "mcpServer.remove"
              ? `Remove the MCP Server ${server} from ${name(path)}`
              : `Turn the MCP Server ${server} ${on ? "On" : "Off"} in ${name(path)}`,
          reasons: reasons(
            [path],
            [
              category === "mcpServer.remove" && "mcpServer",
              mode === "shared" && "sharedMcpServer",
              discardEdits === true && "discardEdits",
            ],
          ),
        };
      }
      case "import": {
        // skills.sh Get is an Import of one listing.
        if (typeof (input as { id?: unknown }).id === "string") {
          return { projects: [], summary: `Get ${(input as { id: string }).id} from skills.sh`, reasons: ["import"] };
        }
        const { input: source, paths } = input as { input: string; paths: string[] };
        return {
          projects: [],
          summary: `Import ${paths.length === 1 ? "1 Skill" : `${paths.length} Skills`} from ${source}`,
          reasons: ["import"],
        };
      }
    }
  }
}
