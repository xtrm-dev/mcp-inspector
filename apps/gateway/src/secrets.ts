import type { CredentialRef, Storage } from "@mcp-inspector-x/storage";
import type { RunnerClient } from "@mcp-inspector-x/runner";

// Service name every OS-keychain entry is filed under; account = credential
// ref id, which is unique per row.
const KEYCHAIN_SERVICE = "mcp-inspector-x";

export interface SecretsRegistry {
  /**
   * Resolve a credential reference to its underlying secret value.
   * Throws if the reference is unknown or the underlying secret cannot be located.
   * Every resolved secret is added to the redaction set so the same string is
   * scrubbed from any downstream export (packets, logs, evidence payloads).
   */
  resolve(refId: string): Promise<string>;

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

  /**
   * Register an additional raw secret value for redaction, outside the
   * normal `resolve()` path — e.g. an OAuth access/refresh token extracted
   * from a persisted state blob. Same central redaction set `resolve()`
   * feeds; this is just another way in.
   */
  noteSecret(value: string): void;

  /**
   * Store a secret value for a session- or os-backed CredentialRef. Not
   * valid for "env" refs (their value always comes from process.env).
   */
  put(ref: CredentialRef, value: string): Promise<void>;

  /** Remove a stored secret, e.g. when its CredentialRef is deleted. */
  remove(ref: CredentialRef): Promise<void>;

  /**
   * Clears the in-memory session-secret store. OS-keychain secrets are
   * untouched (that's the point of choosing "os" — durability across
   * restarts); "session" secrets are gone after this, by design.
   */
  dispose(): Promise<void>;
}

export interface SecretsRegistryOptions {
  storage: Storage;
  /** Injectable env for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Required for the "os" provider (OS keychain access is only ever
   * reached through the privileged runner — see ADR-0003). Without it,
   * "os"-provider resolve()/put() throw a clear configuration error.
   */
  runnerClient?: RunnerClient;
}

export function createSecretsRegistry(options: SecretsRegistryOptions): SecretsRegistry {
  const env = options.env ?? process.env;
  const runnerClient = options.runnerClient;
  const known = new Set<string>();
  const session = new Map<string, string>();

  function requireRunner(): RunnerClient {
    if (!runnerClient) {
      throw new Error(
        "'os' provider requires a privileged runner (none configured on this SecretsRegistry) — " +
          "OS keychain access only ever goes through the runner IPC boundary, never the gateway directly",
      );
    }
    return runnerClient;
  }

  async function resolveRef(ref: CredentialRef): Promise<string> {
    if (ref.provider === "env") {
      const value = env[ref.key];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`env var '${ref.key}' is not set (credential ref '${ref.id}')`);
      }
      return value;
    }
    if (ref.provider === "session") {
      const value = session.get(ref.id);
      if (value === undefined) {
        throw new Error(`session secret for credential ref '${ref.id}' is not set`);
      }
      return value;
    }
    // "os"
    const client = requireRunner();
    const { value } = await client.keychainGet({ service: KEYCHAIN_SERVICE, account: ref.id });
    if (value === null) {
      throw new Error(`OS keychain has no entry for credential ref '${ref.id}'`);
    }
    return value;
  }

  return {
    async resolve(refId) {
      const ref = options.storage.credentials.get(refId);
      if (!ref) throw new Error(`unknown credential ref '${refId}'`);
      const value = await resolveRef(ref);
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
    noteSecret(value) {
      if (value.length > 0) known.add(value);
    },
    async put(ref, value) {
      if (ref.provider === "env") {
        throw new Error(`'env' credential ref '${ref.id}' cannot be written — set the environment variable instead`);
      }
      if (ref.provider === "session") {
        session.set(ref.id, value);
        known.add(value);
        return;
      }
      const client = requireRunner();
      await client.keychainSet({ service: KEYCHAIN_SERVICE, account: ref.id, value });
      known.add(value);
    },
    async remove(ref) {
      if (ref.provider === "session") {
        session.delete(ref.id);
        return;
      }
      if (ref.provider === "os") {
        if (!runnerClient) return; // best-effort: nothing we can reach without a runner
        await runnerClient.keychainDelete({ service: KEYCHAIN_SERVICE, account: ref.id }).catch(() => {});
      }
    },
    async dispose() {
      session.clear();
      known.clear();
    },
  };
}
