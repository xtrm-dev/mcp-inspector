import { spawn } from "node:child_process";

/**
 * Platform-native OS credential store, reached only from inside the
 * privileged runner (see ADR-0003 + Phase I slice 2 constraints — the
 * gateway process must never shell out to `security`/`secret-tool`/DPAPI
 * itself). Every backend shells to a tool the OS already ships; no native
 * addon is installed.
 *
 * ponytail: rejected `keytar@7` — unmaintained since 2021, ships a
 * prebuilt native addon needing per-Node/Electron ABI rebuilds (this repo's
 * own `npm ci` already warns "prebuild-install: No longer maintained" for an
 * unrelated native dep), and a compiled binary is harder to audit at the
 * privileged boundary than a spawned CLI whose argv is fully visible in
 * logs. Shell-out is zero-dep and each OS already ships the tool: macOS
 * `security`, most Linux desktops `secret-tool` (libsecret), Windows via a
 * short PowerShell DPAPI script (the same protection Credential Manager
 * itself is built on).
 */
export interface OsKeychainBackend {
  get(service: string, account: string): Promise<string | undefined>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function macBackend(): OsKeychainBackend {
  return {
    async get(service, account) {
      const r = await run("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (r.code !== 0) return undefined;
      return r.stdout.replace(/\n$/, "");
    },
    async set(service, account, value) {
      const r = await run("security", [
        "add-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
        value,
        "-U",
      ]);
      if (r.code !== 0) throw new Error(`security add-generic-password failed: ${r.stderr.trim()}`);
    },
    async delete(service, account) {
      const r = await run("security", ["delete-generic-password", "-a", account, "-s", service]);
      // Exit 44 = item not found; deleting a nonexistent item is a no-op.
      if (r.code !== 0 && r.code !== 44) {
        throw new Error(`security delete-generic-password failed: ${r.stderr.trim()}`);
      }
    },
  };
}

function linuxBackend(): OsKeychainBackend {
  return {
    async get(service, account) {
      const r = await run("secret-tool", ["lookup", "service", service, "account", account]);
      if (r.code !== 0) return undefined;
      return r.stdout.replace(/\n$/, "");
    },
    async set(service, account, value) {
      const label = `mcp-inspector-x:${service}:${account}`;
      const r = await run(
        "secret-tool",
        ["store", "--label", label, "service", service, "account", account],
        value,
      );
      if (r.code !== 0) throw new Error(`secret-tool store failed: ${r.stderr.trim()}`);
    },
    async delete(service, account) {
      const r = await run("secret-tool", ["clear", "service", service, "account", account]);
      if (r.code !== 0) throw new Error(`secret-tool clear failed: ${r.stderr.trim()}`);
    },
  };
}

// Windows has no CLI that round-trips an arbitrary secret (`cmdkey` cannot
// read back a stored password). We fall back to a DPAPI-encrypted file per
// (service, account) under %APPDATA% — DPAPI ties the ciphertext to the
// current OS user, the same primitive Credential Manager itself uses.
function windowsBackend(): OsKeychainBackend {
  const target = (service: string, account: string) =>
    `$env:APPDATA + '\\mcp-inspector-x\\keychain\\' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('${service.replace(/'/g, "''")}|${account.replace(/'/g, "''")}')).Replace('/','_') + '.bin'`;
  const psRun = (script: string) => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return {
    async get(service, account) {
      const path = target(service, account);
      const script = `$p = ${path}; if (-not (Test-Path $p)) { exit 1 }; try { $bytes = [Convert]::FromBase64String([IO.File]::ReadAllText($p)); $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) } catch { exit 1 }`;
      const r = await psRun(script);
      if (r.code !== 0) return undefined;
      return r.stdout;
    },
    async set(service, account, value) {
      const path = target(service, account);
      const b64Value = Buffer.from(value, "utf8").toString("base64");
      const script = `$p = ${path}; New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null; $plain = [Convert]::FromBase64String('${b64Value}'); $enc = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [IO.File]::WriteAllText($p, [Convert]::ToBase64String($enc))`;
      const r = await psRun(script);
      if (r.code !== 0) throw new Error(`DPAPI keychain set failed: ${r.stderr.trim()}`);
    },
    async delete(service, account) {
      const path = target(service, account);
      const script = `$p = ${path}; if (Test-Path $p) { Remove-Item -Force $p }`;
      const r = await psRun(script);
      if (r.code !== 0) throw new Error(`DPAPI keychain delete failed: ${r.stderr.trim()}`);
    },
  };
}

export function createOsKeychainBackend(platform: NodeJS.Platform = process.platform): OsKeychainBackend {
  if (platform === "darwin") return macBackend();
  if (platform === "win32") return windowsBackend();
  return linuxBackend();
}
