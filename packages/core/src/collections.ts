import {
  type ActivitySubject,
  type ClientKind,
  type Collection,
  CollectionExists,
  type CollectionItem,
  CollectionItemNotFound,
  CollectionNotFound,
  type CollectionRecord,
  type KeyRename,
  type SettingsFile,
} from "@dark-matter/contracts";
import type { CoreServices } from "@dark-matter/contracts/router";
import type { ActivityLog, Wrote } from "./activity";
import { deliveredName } from "./delivery";
import { homeRelative } from "./home-path";
import type { Library } from "./library";
import type { KeyRenameHook } from "./namespace-rename";
import type { OwnedFile } from "./owned-file";
import type { ProjectSkillService } from "./project-skills";

export interface CollectionOptions {
  settings: OwnedFile<typeof SettingsFile>;
  library: Library;
  activity: ActivityLog;
  projectSkills: Pick<ProjectSkillService, "preview" | "applyCollection">;
  onChange: () => void;
}

/** Drops repeated items, keeping the first: a Collection is a flat list of distinct things. */
const distinct = (items: readonly CollectionItem[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = `${item.kind}:${item.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/**
 * Collections (#36): named, flat lists of Library Skills kept in
 * `settings.json`. A template: applying one adds ordinary Project Skills, and
 * nothing links the Project back to the Collection afterwards.
 */
export class Collections {
  readonly #options: CollectionOptions;

  constructor(options: CollectionOptions) {
    this.#options = options;
  }

  get #all() {
    return this.#options.settings.value.collections;
  }

  /** Its Library Skill keys, in order. */
  #skillItems(name: string) {
    return this.record(name).items.flatMap((item) => (item.kind === "skill" ? [item.key] : []));
  }

  record(name: string): CollectionRecord {
    const found = this.#all[name];
    if (!found) throw new CollectionNotFound(name);
    return found;
  }

  async view(name: string): Promise<Collection> {
    const { library } = this.#options;
    const skills = library.lock.value.skills;
    const items = await Promise.all(
      this.record(name).items.map(async (item) => ({
        ...item,
        name: await deliveredName(library, item.key),
        missing: !(item.key in skills),
      })),
    );
    return { name, items };
  }

  #track<T>(client: ClientKind, action: string, subjects: ActivitySubject[], run: (wrote: Wrote) => Promise<T>) {
    return this.#options.activity.track({ client, action, subjects }, async (wrote) => {
      try {
        return await run(wrote);
      } finally {
        this.#options.onChange();
      }
    });
  }

  /** Writes the Collections map through `edit`. */
  async #save(wrote: Wrote, edit: (current: SettingsFile["collections"]) => SettingsFile["collections"]) {
    wrote(await this.#options.settings.update((file) => ({ ...file, collections: edit(file.collections) })));
  }

  /** Rename Namespace (#24): Collection items follow their Skills to the new keys. */
  keyRenameHook(home: string): KeyRenameHook {
    const { settings } = this.#options;
    const path = homeRelative(home, settings.path);
    const using = (renames: KeyRename[]) =>
      Object.values(settings.value.collections).filter((record) =>
        record.items.some((item) => renames.some((rename) => rename.from === item.key)),
      ).length;
    return {
      steps: async (renames) => {
        const count = using(renames);
        if (count === 0) return [];
        const change = `re-key renamed Skills in ${count} Collection${count === 1 ? "" : "s"}`;
        return [{ kind: "editFile", path, change }];
      },
      editFile: async (step, renames) => {
        if (step.path !== path) return null;
        const rekey = (key: string) => renames.find((rename) => rename.from === key)?.to ?? key;
        const written = await settings.update((file) => ({
          ...file,
          collections: Object.fromEntries(
            Object.entries(file.collections).map(([name, record]) => [
              name,
              { ...record, items: record.items.map((item) => ({ ...item, key: rekey(item.key) })) },
            ]),
          ),
        }));
        return written ? [written] : [];
      },
    };
  }

  services(): CoreServices["collections"] {
    const subject = (name: string): ActivitySubject => ({ kind: "collection", id: name });
    return {
      list: () =>
        Promise.all(
          Object.keys(this.#all)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => this.view(name)),
        ),
      create: ({ name, items }, client) =>
        this.#track(client, "collections.create", [subject(name)], async (wrote) => {
          if (name in this.#all) throw new CollectionExists(name);
          await this.#save(wrote, (current) => ({ ...current, [name]: { items: distinct(items) } }));
          return this.view(name);
        }),
      rename: ({ name, newName }, client) =>
        this.#track(client, "collections.rename", [subject(name), subject(newName)], async (wrote) => {
          const record = this.record(name);
          if (newName !== name && newName in this.#all) throw new CollectionExists(newName);
          await this.#save(wrote, ({ [name]: _old, ...rest }) => ({ ...rest, [newName]: record }));
          return this.view(newName);
        }),
      setItems: ({ name, items }, client) =>
        this.#track(client, "collections.setItems", [subject(name)], async (wrote) => {
          this.record(name);
          await this.#save(wrote, (current) => ({ ...current, [name]: { items: distinct(items) } }));
          return this.view(name);
        }),
      delete: (name, client) =>
        this.#track(client, "collections.delete", [subject(name)], async (wrote) => {
          this.record(name);
          await this.#save(wrote, ({ [name]: _gone, ...rest }) => rest);
        }),
      plan: async ({ name, projects, modes = {} }) => {
        const items = this.#skillItems(name).map((key) => ({ key, mode: modes[key] ?? ("link" as const) }));
        const cells = [];
        for (const path of projects) cells.push(...(await this.#options.projectSkills.preview(path, items)));
        return { name, cells };
      },
      apply: ({ name, skills }, client) => {
        const keys = new Set(this.#skillItems(name));
        const outside = skills.find((skill) => !keys.has(skill.key));
        if (outside) return Promise.reject(new CollectionItemNotFound(name, outside.key));
        return this.#options.projectSkills.applyCollection(name, skills, client);
      },
    };
  }
}
