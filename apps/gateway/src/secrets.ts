import type { CredentialRef, Storage } from "@mcp-inspector-x/storage";

export interface SecretsRegistry {
  /**
   * Resolve a credential reference to its underlying secret value.
   * Throws if the reference is unknown or the underlying secret cannot be located.
   * Every resolved secret is added to the redaction set so the same string is
   * scrubbed from any downstream export (packets, logs, evidence payloads).
   */
  resolve(refId: string): string;

  /**
   * All secrets this registry has ever surfaced. Callers use this to redact
   * any known secret that shows up in outbound content — belt and suspenders
   * for the sensitive-key regex.
   */
  known(): ReadonlySet<string>;

  /**
   * Scrub any known-secret substring from a string. Returns the input
   * unchanged if no known secret is present.
   */
  scrub(input: string): string;
}

export interface SecretsRegistryOptions {
  storage: Storage;
  /** Injectable env for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export function createSecretsRegistry(options: SecretsRegistryOptions): SecretsRegistry {
  const env = options.env ?? process.env;
  const known = new Set<string>();

  function resolveRef(ref: CredentialRef): string {
    if (ref.provider === "env") {
      const value = env[ref.key];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`env var '${ref.key}' is not set (credential ref '${ref.id}')`);
      }
      return value;
    }
    // OS + session providers land in Phase I slice 2.
    throw new Error(`provider '${ref.provider}' not supported yet (credential ref '${ref.id}')`);
  }

  return {
    resolve(refId) {
      const ref = options.storage.credentials.get(refId);
      if (!ref) throw new Error(`unknown credential ref '${refId}'`);
      const value = resolveRef(ref);
      known.add(value);
      return value;
    },
    known() {
      return known;
    },
    scrub(input) {
      if (known.size === 0 || input.length === 0) return input;
      let out = input;
      for (const secret of known) {
        if (secret.length === 0) continue;
        if (out.includes(secret)) {
          out = out.split(secret).join("[REDACTED]");
        }
      }
      return out;
    },
  };
}
