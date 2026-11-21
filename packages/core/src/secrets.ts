import { execFile } from "node:child_process";
import { KeychainUnavailable } from "@dark-matter/contracts";

/**
 * The OS keychain, where Secrets live (ADR-0005). Library definitions hold
 * Secret names only; values go in and come out through this interface alone.
 * Every entry is a generic password under the service `dark-matter`, with the
 * Secret name as its account.
 */
export interface SecretStore {
  /** The value, or null when there's no such Secret. */
  get(name: string): Promise<string | null>;
  /** Stores or replaces a Secret. */
  set(name: string, value: string): Promise<void>;
  /** Removes a Secret; a missing one is fine. */
  delete(name: string): Promise<void>;
}

const SERVICE = "dark-matter";

/** An in-memory keychain, for tests and `DARK_MATTER_SECRETS=memory`. `values` is the live map. */
export const memorySecrets = (values = new Map<string, string>()): SecretStore & { values: Map<string, string> } => ({
  values,
  get: async (name) => values.get(name) ?? null,
  set: async (name, value) => void values.set(name, value),
  delete: async (name) => void values.delete(name),
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (command: string, args: string[], input?: string): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      if (error && typeof error.code !== "number") reject(new KeychainUnavailable(`${command}: ${error.message}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin?.end(input ?? "");
  });

const failed = (command: string, result: Run) =>
  new KeychainUnavailable(`${command} exited ${result.code}: ${result.stderr.trim()}`);

/** A token for `security -i`, which splits its input lines on spaces and honours double quotes. */
const quote = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;

/**
 * The macOS login keychain through the `security` CLI. Values are written
 * through `security -i` on stdin, so they never appear in a process list.
 */
export const macosKeychain = (): SecretStore => ({
  async get(name) {
    const result = await run("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    if (result.code === 44) return null;
    if (result.code !== 0) throw failed("security", result);
    return result.stdout.replace(/\n$/, "");
  },
  async set(name, value) {
    if (/[\r\n]/.test(value)) throw new KeychainUnavailable("a Secret can't span lines");
    const line = ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `Dark Matter: ${name}`, "-w", value];
    const result = await run("security", ["-i"], `${line.map(quote).join(" ")}\n`);
    if (result.code !== 0 || result.stderr.trim() !== "") throw failed("security", result);
  },
  async delete(name) {
    const result = await run("security", ["delete-generic-password", "-s", SERVICE, "-a", name]);
    if (result.code !== 0 && result.code !== 44) throw failed("security", result);
  },
});

/** libsecret (GNOME Keyring, KWallet) on Linux through `secret-tool`; values go in on stdin. */
export const libsecret = (): SecretStore => ({
  async get(name) {
    const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", name]);
    if (result.code === 1 && result.stdout === "") return null;
    if (result.code !== 0) throw failed("secret-tool", result);
    return result.stdout;
  },
  async set(name, value) {
    const result = await run(
      "secret-tool",
      ["store", "--label", `Dark Matter: ${name}`, "service", SERVICE, "account", name],
      value,
    );
    if (result.code !== 0) throw failed("secret-tool", result);
  },
  async delete(name) {
    const result = await run("secret-tool", ["clear", "service", SERVICE, "account", name]);
    if (result.code !== 0 && result.code !== 1) throw failed("secret-tool", result);
  },
});

/** The platform's keychain, or the in-memory one when `DARK_MATTER_SECRETS=memory` (development, e2e tests). */
export const defaultSecretStore = (env: { DARK_MATTER_SECRETS?: string | undefined }): SecretStore => {
  if (env.DARK_MATTER_SECRETS === "memory") return memorySecrets();
  if (process.platform === "darwin") return macosKeychain();
  if (process.platform === "linux") return libsecret();
  const unavailable = async (): Promise<never> => {
    throw new KeychainUnavailable(`no keychain support on ${process.platform}`);
  };
  return { get: unavailable, set: unavailable, delete: unavailable };
};
