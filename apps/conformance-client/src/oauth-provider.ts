/**
 * R9 slice 2 — dynamic OAuth adapter for the conformance client.
 *
 * Reads env config, exchanges a long-lived refresh_token for a short-lived
 * access_token via the issuer's token endpoint (RFC 6749 §6), caches the
 * result until near-expiry, and refreshes on demand. The operator mints the
 * refresh_token once (browser code-flow, out of band); every subsequent
 * conformance run is unattended.
 *
 * Deliberately narrower than `packages/protocol/src/oauth.ts`: no PKCE, no
 * dynamic registration, no discovery redirect chase. All of that is the
 * production adapter's problem; this one only needs `refresh_token` →
 * `access_token` because the conformance harness is not a browser.
 *
 * ponytail: token_endpoint discovered via RFC 8414
 * (`.well-known/oauth-authorization-server`) once per process; falls back to
 * `${issuer}/token` if discovery 404s. Upgrade path: honor a full
 * `MCP_CONFORMANCE_OAUTH_TOKEN_ENDPOINT` override if a non-standard issuer
 * ever needs it.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DynamicOAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  refreshToken: string;
  scopes?: string;
}

/** Read env; return undefined when any required var is missing (fall back to slice 1). */
export function readOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DynamicOAuthConfig | undefined {
  const issuer = env["MCP_CONFORMANCE_OAUTH_ISSUER"];
  const clientId = env["MCP_CONFORMANCE_OAUTH_CLIENT_ID"];
  const redirectUri = env["MCP_CONFORMANCE_OAUTH_REDIRECT_URI"];
  const refreshToken = env["MCP_CONFORMANCE_OAUTH_REFRESH_TOKEN"];
  if (!issuer || !clientId || !redirectUri || !refreshToken) return undefined;
  const cfg: DynamicOAuthConfig = { issuer, clientId, redirectUri, refreshToken };
  const secret = env["MCP_CONFORMANCE_OAUTH_CLIENT_SECRET"];
  if (secret) cfg.clientSecret = secret;
  const scopes = env["MCP_CONFORMANCE_OAUTH_SCOPES"];
  if (scopes) cfg.scopes = scopes;
  return cfg;
}

export class DynamicOAuthError extends Error {
  readonly kind: "http" | "network" | "malformed";
  readonly status?: number;
  constructor(kind: "http" | "network" | "malformed", message: string, status?: number) {
    super(message);
    this.name = "DynamicOAuthError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Refresh a bit before the AS-reported expiry to avoid races on the wire. */
const EXPIRY_SKEW_MS = 30_000;

export class DynamicOAuthProvider {
  private readonly cfg: DynamicOAuthConfig;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private tokenEndpoint: string | undefined;
  private cache: CachedToken | undefined;

  constructor(cfg: DynamicOAuthConfig, opts: { fetchFn?: FetchLike; now?: () => number } = {}) {
    this.cfg = cfg;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  async getAccessToken(): Promise<string> {
    if (this.cache && this.cache.expiresAtMs - EXPIRY_SKEW_MS > this.now()) {
      return this.cache.accessToken;
    }
    const endpoint = await this.resolveTokenEndpoint();
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", this.cfg.refreshToken);
    body.set("client_id", this.cfg.clientId);
    if (this.cfg.clientSecret) body.set("client_secret", this.cfg.clientSecret);
    if (this.cfg.scopes) body.set("scope", this.cfg.scopes);

    let res: Response;
    try {
      res = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new DynamicOAuthError("network", `token endpoint ${endpoint} unreachable: ${errMsg(err)}`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      throw new DynamicOAuthError(
        "http",
        `token endpoint ${endpoint} returned ${res.status}: ${text}`,
        res.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new DynamicOAuthError("malformed", `token endpoint returned non-JSON: ${errMsg(err)}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new DynamicOAuthError("malformed", "token endpoint returned non-object body");
    }
    const obj = parsed as Record<string, unknown>;
    const accessToken = obj["access_token"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new DynamicOAuthError("malformed", "token endpoint response missing 'access_token'");
    }
    const expiresIn = typeof obj["expires_in"] === "number" ? (obj["expires_in"] as number) : 300;
    this.cache = {
      accessToken,
      expiresAtMs: this.now() + expiresIn * 1000,
    };
    return accessToken;
  }

  private async resolveTokenEndpoint(): Promise<string> {
    if (this.tokenEndpoint) return this.tokenEndpoint;
    const issuer = this.cfg.issuer.replace(/\/+$/, "");
    const discoveryUrl = `${issuer}/.well-known/oauth-authorization-server`;
    try {
      const res = await this.fetchFn(discoveryUrl, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const meta = (await res.json()) as { token_endpoint?: unknown };
        if (typeof meta.token_endpoint === "string" && meta.token_endpoint !== "") {
          this.tokenEndpoint = meta.token_endpoint;
          return this.tokenEndpoint;
        }
      }
    } catch {
      // Fall through to default — a discovery outage should not block the run.
    }
    this.tokenEndpoint = `${issuer}/token`;
    return this.tokenEndpoint;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
