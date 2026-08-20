import {
  auth,
  type AuthResult,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/**
 * MCP 2026-07-28 authorization spec, consumed via the SDK's own OAuth
 * client (`@modelcontextprotocol/client`'s `auth()` orchestrator): RFC 9728
 * protected-resource discovery, RFC 8414 authorization-server discovery,
 * RFC 7591 dynamic client registration, RFC 7636 PKCE, RFC 8707 resource
 * indicator, and refresh — all implemented by the SDK. Nothing here
 * re-implements any of that; this module only supplies the storage +
 * redirect plumbing an `OAuthClientProvider` needs to plug into it.
 *
 * ponytail: no interactive browser / consent UI (out of scope — see bead
 * NON_GOALS). `redirectToAuthorization` follows the authorization
 * endpoint's HTTP redirect chain itself (manual `fetch` redirects) looking
 * for our own loopback `redirectUrl`, instead of opening a real browser and
 * listening on it. This works for auto-approving / pre-consented issuers
 * (our mock test issuer, and dev-oriented remote MCP servers using
 * pre-registered trusted clients) but NOT for an issuer that requires a
 * human to click through a real login page — that needs a system-browser +
 * loopback-listener flow, deferred alongside consent UI. Silent token
 * *refresh* (the common steady-state case) does not go through this path
 * at all — it's handled entirely by the SDK's built-in 401 retry.
 */

/** The whole of what an OAuthClientProvider needs to survive across
 * reconnects, serialized as one blob and handed to the caller's storage. */
export interface OAuthPersistedState {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  resourceUrl?: string;
}

export interface OAuthStateStore {
  load(): OAuthPersistedState | undefined;
  save(state: OAuthPersistedState): void | Promise<void>;
}

export interface CreateOAuthClientProviderOptions {
  /** The MCP server (resource) URL this provider authorizes access to —
   * must be the same value passed to `runOAuthFlow`'s `serverUrl` and to
   * the transport. Used for the RFC 8707 `resource` indicator on the
   * code-exchange leg `redirectToAuthorization` drives internally. */
  serverUrl: string | URL;
  /** Our own loopback callback URL — chosen by us, not the AS; never
   * actually listened on (see module docs). */
  redirectUrl: string;
  clientName?: string;
  store: OAuthStateStore;
  /** Custom fetch for the manual-redirect-follow step. Defaults to global `fetch`. */
  fetchFn?: FetchLike;
}

const MAX_REDIRECT_HOPS = 10;

/**
 * Builds an `OAuthClientProvider` (the SDK's interface) backed by a caller
 *-supplied `OAuthStateStore`. All persistence — client registration,
 * tokens, discovery state — round-trips through `store`, so the caller
 * decides where the blob actually lives (CredentialRef + SecretsRegistry in
 * the gateway).
 */
export function createOAuthClientProvider(options: CreateOAuthClientProviderOptions): OAuthClientProvider {
  const { serverUrl, redirectUrl, store } = options;
  const fetchFn = options.fetchFn ?? fetch;
  let cache: OAuthPersistedState = store.load() ?? {};
  let codeVerifier: string | undefined;

  async function persist(patch: OAuthPersistedState): Promise<void> {
    cache = { ...cache, ...patch };
    await store.save(cache);
  }

  // Self-referencing on purpose: `redirectToAuthorization` below needs to
  // pass this very provider back into `auth()` for the code-exchange leg.
  // The method body only reads `provider` when invoked, by which point this
  // `const` has finished initializing, so the forward reference is safe.
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [redirectUrl],
        client_name: options.clientName ?? "MCP Inspector X",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
    },
    clientInformation() {
      return cache.clientInformation;
    },
    async saveClientInformation(info) {
      await persist({ clientInformation: info });
    },
    tokens() {
      return cache.tokens;
    },
    async saveTokens(tokens) {
      await persist({ tokens });
    },
    async redirectToAuthorization(authorizationUrl) {
      const { code, iss } = await followAuthorizationRedirect(authorizationUrl, redirectUrl, fetchFn);
      // authInternal() unconditionally returns "REDIRECT" right after this
      // resolves (see @modelcontextprotocol/client's auth.ts) — it never
      // loops back to exchange the code itself. We complete the exchange
      // here, inline, since this is the only call site holding the code.
      const opts: Parameters<typeof auth>[1] = { serverUrl, authorizationCode: code, fetchFn };
      if (iss !== undefined) opts.iss = iss;
      const result = await auth(provider, opts);
      if (result !== "AUTHORIZED") {
        throw new Error(`oauth: authorization_code exchange did not complete (got '${result}')`);
      }
    },
    async saveCodeVerifier(verifier) {
      codeVerifier = verifier;
    },
    codeVerifier() {
      if (codeVerifier === undefined) throw new Error("oauth: no PKCE code_verifier saved for this flow");
      return codeVerifier;
    },
    async saveDiscoveryState(state) {
      await persist({ discoveryState: state });
    },
    discoveryState() {
      return cache.discoveryState;
    },
    async saveResourceUrl(url) {
      await persist({ resourceUrl: url });
    },
    resourceUrl() {
      return cache.resourceUrl;
    },
    async invalidateCredentials(scope) {
      const next: OAuthPersistedState = { ...cache };
      if (scope === "all" || scope === "tokens") delete next.tokens;
      if (scope === "all" || scope === "client") delete next.clientInformation;
      if (scope === "all" || scope === "discovery") delete next.discoveryState;
      if (scope === "all" || scope === "verifier") codeVerifier = undefined;
      cache = next;
      await store.save(cache);
    },
  };

  return provider;
}

/**
 * Follows the authorization endpoint's redirect chain by hand (manual
 * `fetch`, no real browser) until it lands on our own `redirectUri`, then
 * extracts `code`/`state`/`iss` from the query string. See module docs for
 * why: no interactive consent UI in this slice, so this only works against
 * an authorization server that redirects straight through without asking a
 * human to click anything (our mock test issuer, or a pre-consented/dev
 * issuer).
 */
async function followAuthorizationRedirect(
  authorizationUrl: URL,
  redirectUri: string,
  fetchFn: FetchLike,
): Promise<{ code: string; state: string | null; iss?: string }> {
  const target = new URL(redirectUri);
  let current: URL = authorizationUrl;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const res = await fetchFn(current, { redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(
        `oauth: authorization endpoint returned ${res.status} without a redirect — interactive user consent ` +
          `is not supported in this build (see packages/protocol/src/oauth.ts)`,
      );
    }
    const next = new URL(location, current);
    if (next.origin === target.origin && next.pathname === target.pathname) {
      const error = next.searchParams.get("error");
      if (error) {
        const desc = next.searchParams.get("error_description");
        throw new Error(`oauth: authorization denied: ${error}${desc ? ` (${desc})` : ""}`);
      }
      const code = next.searchParams.get("code");
      if (!code) throw new Error("oauth: redirect to callback URL is missing the 'code' parameter");
      const result: { code: string; state: string | null; iss?: string } = {
        code,
        state: next.searchParams.get("state"),
      };
      const iss = next.searchParams.get("iss");
      if (iss !== null) result.iss = iss;
      return result;
    }
    current = next;
  }
  throw new Error("oauth: too many redirects while following the authorization endpoint");
}

/**
 * Runs the full `auth()` flow for a server that has no valid cached
 * tokens: discovery → (dynamic registration) → PKCE authorization-code
 * exchange, or, if a refresh token is already cached, a silent refresh.
 * Called proactively from `ensureDescriptor` before the first connect
 * attempt — not reactively off a 401 — so the very first request already
 * carries a valid bearer token. Subsequent mid-session expiry is handled
 * by the SDK transport's own 401→refresh retry, with no extra code here.
 *
 * Note on the return value: `@modelcontextprotocol/client`'s `auth()`
 * unconditionally returns `"REDIRECT"` the moment `provider
 * .redirectToAuthorization()` resolves — even though *our*
 * `redirectToAuthorization` (see `createOAuthClientProvider` above)
 * already drove the code-exchange leg to completion inside that same call.
 * So a bare `"REDIRECT"` here does not mean the flow is unfinished; it's
 * corrected below by checking whether tokens actually landed.
 */
export async function runOAuthFlow(options: {
  serverUrl: string | URL;
  provider: OAuthClientProvider;
  fetchFn?: FetchLike;
}): Promise<AuthResult> {
  const authOpts: Parameters<typeof auth>[1] = { serverUrl: options.serverUrl };
  if (options.fetchFn) authOpts.fetchFn = options.fetchFn;
  const result = await auth(options.provider, authOpts);
  if (result === "AUTHORIZED") return result;
  return (await options.provider.tokens()) ? "AUTHORIZED" : result;
}
