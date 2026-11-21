import type { McpDefinition } from "@dark-matter/contracts";

/** A value Adopt moves into the keychain: the env var or header it was in, and the Secret name it gets. */
export interface InlineSecret {
  key: string;
  name: string;
  value: string;
}

/** Env var names that hold credentials. */
const SECRET_ENV =
  /(token|secret|passw(or)?d|credential|auth|api[_-]?key|access[_-]?key|private[_-]?key|_key$|^key$|_pat$|^pat$)/i;
/** Header names that hold credentials. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie)$|token|secret|api[_-]?key|auth/i;
/** `Bearer <token>`: only the token is the Secret, the scheme stays in the definition. */
const SCHEME = /^(Bearer|Basic|Token|token|bearer)(\s+)(\S+)$/;

/** A literal value, not an `${env:…}` or `${secret:…}` reference (or another Agent's interpolation). */
const literal = (value: string) => value.trim() !== "" && !value.includes("${") && !/\{(env|file):/.test(value);

/** A Secret reference in a definition. */
export const secretRef = (name: string) => `\${secret:${name}}`;

/** Every Secret name a definition refers to. */
export const secretNames = (definition: McpDefinition): string[] => {
  const values = [...Object.values(definition.env ?? {}), ...Object.values(definition.headers ?? {})];
  return [
    ...new Set(values.flatMap((value) => [...value.matchAll(/\$\{secret:([^}]+)\}/g)].map((match) => match[1] ?? ""))),
  ].sort();
};

/**
 * Replaces inline credentials in `env` and `headers` with `${secret:<server>.<key>}`
 * references, returning the values separately. Which values count is a
 * heuristic on the key name; the Adopt plan lists every one it moves.
 */
export const maskSecrets = (
  server: string,
  definition: McpDefinition,
): { definition: McpDefinition; secrets: InlineSecret[] } => {
  const secrets: InlineSecret[] = [];
  const mask = (map: Record<string, string> | undefined, isSecret: (key: string) => boolean) => {
    if (!map) return undefined;
    return Object.fromEntries(
      Object.entries(map).map(([key, value]) => {
        if (!isSecret(key) || !literal(value)) return [key, value];
        const name = `${server}.${key}`;
        const scheme = SCHEME.exec(value);
        const secret = scheme?.[3] ?? value;
        secrets.push({ key, name, value: secret });
        return [key, scheme ? `${scheme[1]}${scheme[2]}${secretRef(name)}` : secretRef(name)];
      }),
    );
  };
  const env = mask(definition.env, (key) => SECRET_ENV.test(key));
  const headers = mask(definition.headers, (key) => SECRET_HEADER.test(key));
  return {
    definition: { ...definition, ...(env && { env }), ...(headers && { headers }) },
    secrets,
  };
};
