import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { filterCommands, useCommands } from "./use-commands";

const LIMIT = 50;

/** ⌘K (Ctrl+K off macOS): jump to any Skill, Namespace or Project, or run an action. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = filterCommands(useCommands(query), query).slice(0, LIMIT);
  const selected = results[Math.min(active, results.length - 1)];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (selected)
      listRef.current?.querySelector(`[data-id="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };
  const run = (index: number) => {
    const command = results[index];
    if (!command) return;
    close();
    command.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-black/20" />
        <Dialog.Popup
          data-testid="command-palette"
          className="-translate-x-1/2 fixed top-[15vh] left-1/2 flex max-h-[60vh] w-[min(36rem,calc(100vw-4rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <input
              aria-label="Search Skills, Namespaces, Collections, Projects and actions"
              role="combobox"
              aria-expanded
              aria-controls="command-results"
              aria-activedescendant={selected ? `command-${selected.id}` : undefined}
              className="h-11 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
              placeholder="Jump to a Skill, Namespace, Collection or Project, or run an action…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, results.length - 1));
                else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
                else if (event.key === "Enter") run(Math.min(active, results.length - 1));
                else return;
                event.preventDefault();
              }}
            />
          </div>
          <div ref={listRef} id="command-results" role="listbox" className="overflow-y-auto p-1.5">
            {results.length === 0 && (
              <p className="px-3 py-6 text-center text-muted-foreground text-body">No matches</p>
            )}
            {results.map((command, index) => (
              <div key={command.id}>
                {command.group !== results[index - 1]?.group && (
                  <div className="px-2.5 pt-2 pb-1 font-medium text-micro text-muted-foreground">{command.group}</div>
                )}
                <div
                  id={`command-${command.id}`}
                  data-id={command.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={command === selected}
                  className={cn(
                    "flex h-8 cursor-default items-center gap-3 rounded-md px-2.5 text-body",
                    command === selected && "bg-muted",
                  )}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(index)}
                  onKeyDown={() => {}}
                >
                  <span className="truncate">{command.label}</span>
                  {command.hint && (
                    <span className="ml-auto truncate font-mono text-micro text-muted-foreground">{command.hint}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
