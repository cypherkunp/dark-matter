import type { ActivityRetention, Preferences, PreferencesPatch, Theme } from "@dark-matter/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentsSettings } from "@/components/agents-settings";
import { GitHubSettings } from "@/components/github-settings";
import { OwnedFileProblems } from "@/components/owned-file-problems";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { tildify } from "@/lib/paths";
import { applyTheme } from "@/lib/theme";
import { useTRPC } from "@/lib/trpc";

export const Route = createFileRoute("/settings")({ component: Settings });

const retentionOptions: { value: ActivityRetention; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "365 days" },
  { value: "forever", label: "Forever" },
];

const themeOptions: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

/** The preferences this form edits; the theme, Adopt Permissions and the Guard save on their own. */
type FormPreferences = Required<Omit<PreferencesPatch, "theme">>;

const formPreferences = ({
  scheduledScanTime,
  startAtLogin,
  trashRetentionDays,
  activityRetention,
}: Preferences): FormPreferences => ({ scheduledScanTime, startAtLogin, trashRetentionDays, activityRetention });

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-16 items-center gap-6 px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="font-medium text-body">
          {label}
        </label>
        <p className="text-muted-foreground text-meta">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** Dark, Light or System as one segmented control: applied on click, saved straight away. */
function ThemeRow() {
  const trpc = useTRPC();
  const saved = useQuery(trpc.settings.get.queryOptions()).data?.preferences.theme;
  const save = useMutation(trpc.settings.updatePreferences.mutationOptions());
  const [chosen, setChosen] = useState<Theme | undefined>();
  const theme = chosen ?? saved;
  if (!theme) return null;
  const choose = (next: Theme) => {
    setChosen(next);
    applyTheme(next);
    save.mutate(
      { theme: next },
      {
        onSettled: () => setChosen(undefined),
        // Back to what's saved, so the window never shows a theme that wasn't kept.
        onError: () => saved && applyTheme(saved),
      },
    );
  };
  return (
    <div className="flex min-h-16 items-center gap-6 px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id="theme-label" className="font-medium text-body">
          Appearance
        </span>
        <p className="text-muted-foreground text-meta">
          {save.error ? save.error.message : "System follows the computer's light or dark setting."}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="flex h-8 shrink-0 items-center rounded-full bg-muted p-0.5"
      >
        {themeOptions.map((option) => (
          <label
            key={option.value}
            className="flex h-7 cursor-default items-center rounded-full px-3 font-medium text-body text-muted-foreground transition-colors hover:text-foreground has-checked:bg-background has-checked:text-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-checked:bg-accent"
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              className="sr-only"
              checked={theme === option.value}
              onChange={() => choose(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function Settings() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const problems = useQuery(trpc.ownedFiles.problems.queryOptions());
  const info = useQuery(trpc.core.info.queryOptions());
  const nextScan = useQuery(trpc.scheduler.status.queryOptions()).data?.nextRunAt;
  const save = useMutation(trpc.settings.updatePreferences.mutationOptions());
  const preferences = settings.data?.preferences;
  // Keyed on the form's own fields, so saving an Adopt Permission doesn't reset the draft.
  const saved = preferences && JSON.stringify(formPreferences(preferences));
  const [draft, setDraft] = useState<FormPreferences | undefined>(saved && JSON.parse(saved));

  // Follow the saved preferences when they change (a save, or a hand edit picked up by the core).
  useEffect(() => setDraft(saved && JSON.parse(saved)), [saved]);

  const held = (problems.data?.length ?? 0) > 0;
  const dirty = draft !== undefined && saved !== undefined && JSON.stringify(draft) !== saved;
  const update = (patch: PreferencesPatch) => setDraft((current) => current && { ...current, ...patch });

  return (
    <Page>
      <PageHead
        title="Settings"
        summary="Preferences for this computer"
        {...(info.data && { status: `Saved in ${tildify(info.data.libraryHome)}/settings.json` })}
      />
      <OwnedFileProblems />
      <section className="rounded-xl border">
        <ThemeRow />
      </section>
      {draft && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty) save.mutate(draft);
          }}
        >
          <section className="divide-y rounded-xl border">
            <Row
              label="Scheduled Scan time"
              htmlFor="scheduled-scan-time"
              hint={`A Scan runs every day at this time, or as soon as the computer wakes if it was asleep.${
                nextScan
                  ? ` Next: ${new Date(nextScan).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}.`
                  : ""
              }`}
            >
              <Input
                id="scheduled-scan-time"
                type="time"
                className="w-32 font-mono tabular-nums"
                value={draft.scheduledScanTime}
                onChange={(event) => update({ scheduledScanTime: event.target.value })}
              />
            </Row>
            <Row
              label="Start at login"
              htmlFor="start-at-login"
              hint="Dark Matter stays in the menu bar so the Scheduled Scan keeps running."
            >
              <input
                id="start-at-login"
                type="checkbox"
                className="size-4 accent-primary"
                checked={draft.startAtLogin}
                onChange={(event) => update({ startAtLogin: event.target.checked })}
              />
            </Row>
            <Row label="Keep Activity for" htmlFor="activity-retention" hint="Older Activity Log days are deleted.">
              <Select
                id="activity-retention"
                className="w-32"
                value={String(draft.activityRetention)}
                onChange={(event) =>
                  update({
                    activityRetention: (event.target.value === "forever"
                      ? "forever"
                      : Number(event.target.value)) as ActivityRetention,
                  })
                }
              >
                {retentionOptions.map((option) => (
                  <option key={option.label} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Row>
          </section>
          <div className="flex items-center justify-end gap-3">
            {save.error && <p className="text-muted-foreground text-meta">{save.error.message}</p>}
            <Button type="submit" disabled={!dirty || held || save.isPending}>
              Save
            </Button>
          </div>
        </form>
      )}
      <AgentsSettings />
      <GitHubSettings />
    </Page>
  );
}
