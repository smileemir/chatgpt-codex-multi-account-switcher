import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { CodexCredentialStore, type CodexCredential, type CodexPendingRegistration } from "./auth-store.ts";
import { verifyOpenAiIdToken, type OpenAiIdentity } from "./auth-jwt.ts";

const AUTHORITY = "https://auth.openai.com";
const AUTHORIZE = `${AUTHORITY}/api/accounts/authorize`;
const TOKEN = `${AUTHORITY}/api/accounts/oauth/token`;
const DISCOVERY = `${AUTHORITY}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REQUIRED = ["resource.invoke", "chatgpt.tokens.use.direct"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CodexAccount {
  id: string;
  label: string;
  issuer: string;
  subject: string;
  email: string | null;
  clientId: string;
  scopes: string[];
  connected: boolean;
  expiresAt: number | null;
}

export interface CodexSignInJob {
  jobId: string;
  state: "pending" | "succeeded" | "failed";
  accountId?: string;
  registrationId?: string;
  errorCode?: string;
}

export interface CodexAuthOptions {
  dataRoot: string;
  appName: string;
  openAuthorizationUrl: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  verifyIdentity?: (token: string, clientId: string, nonce: string) => Promise<OpenAiIdentity>;
  now?: () => number;
  timeoutMs?: number;
}

interface PendingJob {
  public: CodexSignInJob;
  server: Server;
  timer: NodeJS.Timeout;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  existing: CodexCredential | null;
  registration: CodexPendingRegistration | null;
  hostId: string;
  consumed: boolean;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^CODEX_AUTH_[A-Z_]+$/.test(message) ? message : "CODEX_AUTH_SIGN_IN_FAILED";
}

function accountView(record: CodexCredential): CodexAccount {
  return { id: record.id, label: record.label, issuer: record.issuer, subject: record.subject,
    email: record.email, clientId: record.clientId, scopes: [...record.scopes],
    connected: Boolean(record.refreshToken && record.accessToken), expiresAt: record.expiresAt || null };
}

function requireAccountId(id: string): void {
  if (!UUID.test(id)) throw new Error("CODEX_AUTH_INVALID_ACCOUNT_ID");
}

async function tokenResponse(http: typeof fetch, body: URLSearchParams): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await http(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body, signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("CODEX_AUTH_TOKEN_REQUEST_FAILED"); }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) throw new Error("CODEX_AUTH_RECONNECT_REQUIRED");
    throw new Error("CODEX_AUTH_TOKEN_REQUEST_FAILED");
  }
  let raw: string;
  try { raw = await response.text(); } catch { throw new Error("CODEX_AUTH_TOKEN_REQUEST_FAILED"); }
  if (raw.length > 64 * 1024) throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE");
  return value as Record<string, unknown>;
}

function scopes(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE");
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

function assertSharing(granted: string[]): void {
  if (!REQUIRED.every((scope) => granted.includes(scope))) throw new Error("CODEX_AUTH_SCOPE_MISSING");
}

export class CodexAuthManager {
  private readonly store: CodexCredentialStore;
  private readonly http: typeof fetch;
  private readonly verifyIdentity: (token: string, clientId: string, nonce: string) => Promise<OpenAiIdentity>;
  private readonly now: () => number;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly refreshes = new Map<string, Promise<string>>();
  private disposed = false;

  constructor(private readonly options: CodexAuthOptions) {
    if (!options.appName.trim() || options.appName.length > 80) throw new Error("CODEX_AUTH_INVALID_APP_NAME");
    this.store = new CodexCredentialStore(options.dataRoot);
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.verifyIdentity = options.verifyIdentity ?? ((token, clientId, nonce) => verifyOpenAiIdToken(token, clientId, nonce, this.http, this.now()));
  }

  async listAccounts(): Promise<CodexAccount[]> {
    return (await this.store.snapshot()).accounts.map(accountView);
  }

  async listPendingRegistrations(): Promise<Array<{ registrationId: string; createdAt: number }>> {
    return (await this.store.snapshot()).pendingRegistrations.map((item) => ({ registrationId: item.id, createdAt: item.createdAt }));
  }

  async startSignIn(existingAccountIdOrRegistrationId?: string): Promise<CodexSignInJob> {
    if (this.disposed) throw new Error("CODEX_AUTH_DISPOSED");
    if (existingAccountIdOrRegistrationId) requireAccountId(existingAccountIdOrRegistrationId);
    const snapshot = await this.store.snapshot();
    const existing = existingAccountIdOrRegistrationId ? snapshot.accounts.find((item) => item.id === existingAccountIdOrRegistrationId) : null;
    const registration = existingAccountIdOrRegistrationId && !existing ?
      snapshot.pendingRegistrations.find((item) => item.id === existingAccountIdOrRegistrationId) : null;
    if (existingAccountIdOrRegistrationId && !existing && !registration) throw new Error("CODEX_AUTH_ACCOUNT_NOT_FOUND");
    if (existingAccountIdOrRegistrationId && [...this.jobs.values()].some((job) =>
      (job.existing?.id === existingAccountIdOrRegistrationId || job.registration?.id === existingAccountIdOrRegistrationId) && job.public.state === "pending")) {
      throw new Error("CODEX_AUTH_SIGN_IN_PENDING");
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("CODEX_AUTH_CALLBACK_FAILED"); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const publicJob: CodexSignInJob = { jobId: randomUUID(), state: "pending",
      ...(!existing ? { registrationId: registration?.id ?? randomUUID() } : {}) };
    const job: PendingJob = { public: publicJob, server, timer: setTimeout(() => this.finish(job, "CODEX_AUTH_TIMEOUT"),
      this.options.timeoutMs ?? 120_000), state, nonce, verifier, redirectUri, existing: existing ?? null,
      registration: registration ?? null,
      hostId: snapshot.hostId, consumed: false };
    job.timer.unref();
    this.jobs.set(publicJob.jobId, job);
    server.on("request", (request, response) => {
      if (request.method !== "GET" || !request.url) { response.writeHead(405).end(); return; }
      let url: URL;
      try { url = new URL(request.url, redirectUri); } catch { response.writeHead(400).end(); return; }
      if (url.pathname !== "/auth/callback" || !equal(url.searchParams.get("state") ?? "", state) || job.consumed) {
        response.writeHead(400).end(); return;
      }
      job.consumed = true;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'" });
      response.end("<!doctype html><title>ChatGPT Codex Multi Account Switcher</title><p>You can return to ChatGPT Codex Multi Account Switcher.</p>");
      void this.complete(job, url).catch((error: unknown) => this.finish(job, safeCode(error)));
    });
    const authUrl = new URL(AUTHORIZE);
    authUrl.searchParams.set("client_id", existing?.clientId ?? registration?.clientId ?? "dynamic_agent_client");
    authUrl.searchParams.set("ext_agent_host_id", snapshot.hostId);
    if (!existing && !registration) authUrl.searchParams.set("agent_name_hint", this.options.appName);
    if (existing) {
      if (existing.idToken) authUrl.searchParams.set("id_token_hint", existing.idToken);
      if (existing.email) authUrl.searchParams.set("login_hint", existing.email);
    }
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("resource", RESOURCE);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", nonce);
    authUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authUrl.searchParams.set("code_challenge_method", "S256");
    try { await this.options.openAuthorizationUrl(authUrl.toString()); }
    catch { this.finish(job, "CODEX_AUTH_BROWSER_FAILED"); throw new Error("CODEX_AUTH_BROWSER_FAILED"); }
    return { ...publicJob };
  }

  status(jobId: string): CodexSignInJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("CODEX_AUTH_JOB_NOT_FOUND");
    return { ...job.public };
  }

  private async complete(job: PendingJob, callback: URL): Promise<void> {
    if (callback.searchParams.has("error")) throw new Error("CODEX_AUTH_DENIED");
    const code = callback.searchParams.get("code");
    const returnedClientId = callback.searchParams.get("client_id");
    if (!code || code.length > 4096) throw new Error("CODEX_AUTH_INVALID_CALLBACK");
    const clientId = job.existing?.clientId ?? job.registration?.clientId ?? returnedClientId;
    if (!clientId || clientId !== clientId.trim() || clientId === "dynamic_agent_client" || clientId.length > 512 || /[\u0000-\u001f\u007f]/.test(clientId) ||
      ((job.existing || job.registration) && returnedClientId && returnedClientId !== clientId)) {
      throw new Error("CODEX_AUTH_CLIENT_MISMATCH");
    }
    // The first dynamic callback has already issued a registration. Persist it
    // before code exchange so invalid_grant/network errors can retry this ID.
    if (!job.existing && !job.registration) {
      if (this.disposed || job.public.state !== "pending") return;
      await this.store.transaction(async (data) => {
        if (data.hostId !== job.hostId || data.accounts.some((item) => item.clientId === clientId) ||
          data.pendingRegistrations.some((item) => item.clientId === clientId)) {
          throw new Error("CODEX_AUTH_DUPLICATE_REGISTRATION");
        }
        data.pendingRegistrations.push({ id: job.public.registrationId!, clientId, createdAt: this.now() });
      });
    }
    const result = await tokenResponse(this.http, new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      code, code_verifier: job.verifier, redirect_uri: job.redirectUri, resource: RESOURCE }));
    if (typeof result.id_token !== "string" || typeof result.access_token !== "string" ||
      typeof result.refresh_token !== "string" || typeof result.expires_in !== "number" ||
      result.expires_in <= 0 || result.token_type !== "Bearer") throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE");
    const granted = scopes(result.scope);
    assertSharing(granted);
    const identity = await this.verifyIdentity(result.id_token, clientId, job.nonce);
    if (identity.issuer !== AUTHORITY || !identity.subject ||
      (job.existing && (identity.subject !== job.existing.subject || identity.issuer !== job.existing.issuer))) {
      throw new Error("CODEX_AUTH_ACCOUNT_MISMATCH");
    }
    if (this.disposed || job.public.state !== "pending") return;
    const id = job.existing?.id ?? randomUUID();
    const expiresIn = result.expires_in;
    let duplicateIdentity = false;
    await this.store.transaction(async (data) => {
      if (data.hostId !== job.hostId) throw new Error("CODEX_AUTH_HOST_MISMATCH");
      const current = job.existing ? data.accounts.find((item) => item.id === job.existing?.id) : null;
      if (job.existing && (!current || current.clientId !== clientId || current.subject !== identity.subject)) {
        throw new Error("CODEX_AUTH_ACCOUNT_MISMATCH");
      }
      if (!job.existing && data.accounts.some((item) => item.clientId === clientId)) {
        throw new Error("CODEX_AUTH_DUPLICATE_REGISTRATION");
      }
      if (!job.existing && !data.pendingRegistrations.some((item) => item.id === job.public.registrationId && item.clientId === clientId)) {
        throw new Error("CODEX_AUTH_REGISTRATION_NOT_FOUND");
      }
      // A second OAuth client can identify the same OpenAI user. It must not
      // appear as another independent account in an A/B/C usage pool.
      if (!job.existing && data.accounts.some((item) => item.issuer === identity.issuer && item.subject === identity.subject)) {
        data.pendingRegistrations = data.pendingRegistrations.filter((item) => item.id !== job.public.registrationId);
        duplicateIdentity = true;
        return;
      }
      const baseLabel = identity.email ?? "ChatGPT account";
      let label = current?.label ?? baseLabel;
      if (!current) {
        let ordinal = 2;
        while (data.accounts.some((item) => item.label === label)) label = `${baseLabel} (${ordinal++})`;
      }
      const credential: CodexCredential = { id, label,
        issuer: identity.issuer, subject: identity.subject, email: identity.email, clientId,
        idToken: result.id_token as string, accessToken: result.access_token as string,
        refreshToken: result.refresh_token as string, scopes: granted,
        expiresAt: this.now() + expiresIn * 1000 };
      if (current) Object.assign(current, credential);
      else data.accounts.push(credential);
      if (job.public.registrationId) data.pendingRegistrations = data.pendingRegistrations.filter((item) => item.id !== job.public.registrationId);
    });
    if (duplicateIdentity) throw new Error("CODEX_AUTH_DUPLICATE_IDENTITY");
    job.public.accountId = id;
    job.public.state = "succeeded";
    this.close(job);
  }

  async getAccessToken(accountId: string): Promise<string> {
    return this.resolveAccessToken(accountId);
  }

  /** Call only after the child process received a verified unauthorized response. */
  async refreshAfterUnauthorized(accountId: string, rejectedAccessToken: string): Promise<string> {
    if (!rejectedAccessToken || rejectedAccessToken.length > 32_768) throw new Error("CODEX_AUTH_INVALID_ACCESS_TOKEN");
    return this.resolveAccessToken(accountId, rejectedAccessToken);
  }

  private async resolveAccessToken(accountId: string, rejectedAccessToken?: string): Promise<string> {
    requireAccountId(accountId);
    const pending = this.refreshes.get(accountId);
    if (pending) {
      const result = await pending;
      if (!rejectedAccessToken || result !== rejectedAccessToken) return result;
    }
    const account = (await this.store.snapshot()).accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("CODEX_AUTH_ACCOUNT_NOT_FOUND");
    if (!account.refreshToken) throw new Error("CODEX_AUTH_RECONNECT_REQUIRED");
    if (account.accessToken && account.expiresAt > this.now() + 60_000 &&
      (!rejectedAccessToken || account.accessToken !== rejectedAccessToken)) return account.accessToken;
    const work = this.store.transaction(async (data) => {
      const current = data.accounts.find((item) => item.id === accountId);
      if (!current?.refreshToken) throw new Error("CODEX_AUTH_RECONNECT_REQUIRED");
      if (current.accessToken && current.expiresAt > this.now() + 60_000 &&
        (!rejectedAccessToken || current.accessToken !== rejectedAccessToken)) return current.accessToken;
      const result = await tokenResponse(this.http, new URLSearchParams({ grant_type: "refresh_token",
        client_id: current.clientId, refresh_token: current.refreshToken, resource: RESOURCE }));
      if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string" ||
        typeof result.expires_in !== "number" || result.expires_in <= 0 || result.token_type !== "Bearer") {
        throw new Error("CODEX_AUTH_INVALID_TOKEN_RESPONSE");
      }
      const granted = scopes(result.scope);
      assertSharing(granted);
      current.accessToken = result.access_token;
      current.refreshToken = result.refresh_token;
      current.expiresAt = this.now() + result.expires_in * 1000;
      current.scopes = granted;
      return current.accessToken;
    }).finally(() => this.refreshes.delete(accountId));
    this.refreshes.set(accountId, work);
    return work;
  }

  async disconnect(accountId: string): Promise<{ revokedAtOpenAI: boolean }> {
    requireAccountId(accountId);
    for (const job of this.jobs.values()) if (job.existing?.id === accountId && job.public.state === "pending") this.finish(job, "CODEX_AUTH_CANCELLED");
    // Wait for a concurrent refresh before revocation so its newest rotating token is used.
    await this.refreshes.get(accountId)?.catch(() => undefined);
    return this.store.transaction(async (data) => {
      const current = data.accounts.find((item) => item.id === accountId);
      if (!current) throw new Error("CODEX_AUTH_ACCOUNT_NOT_FOUND");
      let revokedAtOpenAI = false;
      if (current.refreshToken) {
        try {
          const discovery = await this.http(DISCOVERY, { signal: AbortSignal.timeout(10_000) });
          if (discovery.ok) {
            const metadata = await discovery.json() as Record<string, unknown>;
            const endpoint = metadata.revocation_endpoint;
            if (typeof endpoint === "string" && new URL(endpoint).origin === AUTHORITY) {
              const response = await this.http(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: current.refreshToken, token_type_hint: "refresh_token", client_id: current.clientId }),
                signal: AbortSignal.timeout(10_000) });
              revokedAtOpenAI = response.status === 200;
            }
          }
        } catch { /* Local disconnection still completes; caller sees revocation status. */ }
      }
      current.accessToken = null; current.refreshToken = null; current.idToken = null;
      current.expiresAt = 0;
      return { revokedAtOpenAI };
    });
  }

  private finish(job: PendingJob, errorCode: string): void {
    if (job.public.state !== "pending") return;
    job.public.state = "failed";
    job.public.errorCode = errorCode;
    this.close(job);
  }

  private close(job: PendingJob): void {
    clearTimeout(job.timer);
    job.server.close();
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) this.finish(job, "CODEX_AUTH_CANCELLED");
  }
}

export function createCodexAuthManager(options: CodexAuthOptions): CodexAuthManager {
  return new CodexAuthManager(options);
}
