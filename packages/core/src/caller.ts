import { AsyncLocalStorage } from "node:async_hooks";

/** Who a change is being made for, beyond the client kind (ADR-0006). */
export interface Caller {
  /** The Agent behind an `mcp` or `cli` client. */
  agent?: string | undefined;
  /** The Request being applied. */
  request?: string | undefined;
}

const callers = new AsyncLocalStorage<Caller>();

/** Runs a mutation on behalf of `caller`, so every Activity entry it records names them. */
export const runAs = <T>(caller: Caller, run: () => Promise<T>): Promise<T> => callers.run(caller, run);

/** The caller fields for an Activity entry: only the ones that are set. */
export const currentCaller = (): Caller => {
  const { agent, request } = callers.getStore() ?? {};
  return { ...(agent !== undefined && { agent }), ...(request !== undefined && { request }) };
};
