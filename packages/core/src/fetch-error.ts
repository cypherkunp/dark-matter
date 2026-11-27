/**
 * Why a `fetch` failed, in words. undici wraps every network failure as a bare
 * "fetch failed" and keeps the reason (a certificate error, a refused
 * connection, a DNS miss) on `cause`; surfacing it is what tells a person on a
 * TLS-inspecting network why GitHub or skills.sh is "unreachable".
 */
export const describeFetchError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" && !cause.message.includes(code) ? `${cause.message} (${code})` : cause.message;
  }
  return error.message;
};
