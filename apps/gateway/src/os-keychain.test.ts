import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startRunnerServer,
  generateAuthToken,
  connectRunnerClient,
  type RunnerServerHandle,
  type RunnerClient,
} from "@mcp-inspector-x/runner";
import { openStorage, type Storage } from "@mcp-inspector-x/storage";
import { createSecretsRegistry, type SecretsRegistry } from "./secrets";

// Platform-specific: exercises the *real* platform-native keychain tool
// (macOS `security`, Linux `secret-tool`, Windows DPAPI via PowerShell —
// see packages/runner/src/os-keychain.ts) through the privileged runner's
// IPC surface, never directly. CI images frequently lack a usable secret
// store (no D-Bus session / unlocked keyring on headless Linux, as is the
// case in this very sandbox — `secret-tool` isn't even installed here), so
// this probes availability once and skips the whole suite if the platform
// tool isn't actually usable, rather than failing the build on missing
// infrastructure the bead already anticipated ("skipped-on-CI-per-platform").

// `describe.skipIf` is evaluated at collection time, before any
// `beforeAll` hook runs — so the availability probe has to happen via
// top-level await (this is an ESM test module; vitest supports it), not
// inside a hook, or the skip condition would always see the pre-hook
// default and skip unconditionally.
const runnerDir: string = mkdtempSync(join(tmpdir(), "mix-keychain-runner-"));
const runnerToken = generateAuthToken();
const runnerHandle: RunnerServerHandle = await startRunnerServer({
  socketPath: join(runnerDir, "runner.sock"),
  token: runnerToken,
});
const runnerClient: RunnerClient = await connectRunnerClient({
  socketPath: runnerHandle.socketPath,
  token: runnerToken,
});

let keychainAvailable = false;
try {
  await runnerClient.keychainSet({ service: "mcp-inspector-x-probe", account: "probe", value: "x" });
  await runnerClient.keychainDelete({ service: "mcp-inspector-x-probe", account: "probe" });
  keychainAvailable = true;
} catch {
  keychainAvailable = false;
}

afterAll(async () => {
  await runnerClient.close().catch(() => {});
  await runnerHandle.close().catch(() => {});
  rmSync(runnerDir, { recursive: true, force: true });
});

describe.skipIf(!keychainAvailable)("OS keychain via the privileged runner (platform-specific)", () => {
  it("keychainSet -> keychainGet -> keychainDelete round-trips a secret through the runner IPC boundary", async () => {
    const service = "mcp-inspector-x-test";
    const account = `acct-${Date.now()}`;
    await runnerClient.keychainSet({ service, account, value: "top-secret-oauth-token" });
    const got = await runnerClient.keychainGet({ service, account });
    expect(got.value).toBe("top-secret-oauth-token");

    await runnerClient.keychainDelete({ service, account });
    const afterDelete = await runnerClient.keychainGet({ service, account });
    expect(afterDelete.value).toBeNull();
  });

  describe("SecretsRegistry 'os' provider (backed by the same runner)", () => {
    let dir: string;
    let storage: Storage;
    let secrets: SecretsRegistry;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "mix-keychain-gw-"));
      storage = openStorage({ dataDir: dir });
      secrets = createSecretsRegistry({ storage, runnerClient });
    });

    afterAll(() => {
      storage?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("put() writes through to the OS keychain and resolve() reads it back", async () => {
      const ref = storage.credentials.create({ provider: "os", key: "my-os-secret" });
      await secrets.put(ref, "os-keychain-value");
      expect(await secrets.resolve(ref.id)).toBe("os-keychain-value");
      expect(secrets.known().has("os-keychain-value")).toBe(true);
    });

    it("remove() deletes the OS keychain entry", async () => {
      const ref = storage.credentials.create({ provider: "os", key: "to-remove" });
      await secrets.put(ref, "will-be-removed");
      await secrets.remove(ref);
      await expect(secrets.resolve(ref.id)).rejects.toThrow(/OS keychain has no entry/);
    });
  });
});
