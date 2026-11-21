import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

const methodText = {
  gh: "Using your `gh` login.",
  pat: "Using the token below.",
  anonymous: "No GitHub login: public repos only, 60 requests an hour.",
} as const;

/**
 * Settings › GitHub (#30): Import uses `gh auth token` when the gh CLI is
 * logged in, else this PAT (kept in the OS keychain, never shown again), else
 * goes anonymous.
 */
export function GitHubSettings() {
  const trpc = useTRPC();
  const auth = useQuery(trpc.importer.auth.queryOptions());
  const [token, setToken] = useState("");
  const save = useMutation(trpc.importer.setToken.mutationOptions({ onSuccess: () => setToken("") }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ token: token.trim() });
  };
  return (
    <section data-testid="github-settings" className="flex flex-col gap-3">
      <h2 className="font-semibold text-sm">GitHub</h2>
      <div className="flex flex-col gap-3 rounded-xl border px-5 py-4">
        <p data-testid="github-auth" className="text-sm">
          {auth.data ? methodText[auth.data.method] : "…"}
        </p>
        <form className="flex items-center gap-2" onSubmit={submit}>
          <label htmlFor="github-pat" className="shrink-0 font-medium text-sm">
            Personal access token
          </label>
          <Input
            id="github-pat"
            type="password"
            autoComplete="off"
            placeholder={auth.data?.pat ? "Saved in the keychain" : "ghp_…"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={token.trim() === "" || save.isPending}>
            Store in keychain
          </Button>
          {auth.data?.pat && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() => save.mutate({ token: null })}
            >
              Forget token
            </Button>
          )}
        </form>
        <p className="text-muted-foreground text-xs">
          Used for private repos when the gh CLI isn't logged in. Kept in the OS keychain.
        </p>
        {save.error && <p className="text-sm text-status-warning">{save.error.message}</p>}
      </div>
    </section>
  );
}
