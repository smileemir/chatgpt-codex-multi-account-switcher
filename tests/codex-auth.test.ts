import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAuthManager } from "../apps/native-host/src/codex/auth.ts";
import { verifyOpenAiIdToken } from "../apps/native-host/src/codex/auth-jwt.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const GRANTS = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function jwt(clientId: string, nonce: string, subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: clientId, sub: subject,
    nonce, email: `${subject}@example.test`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}

async function withRoot(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function waitFor(manager: ReturnType<typeof createCodexAuthManager>, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.status(jobId).state !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("auth job remained pending");
}

test("verifies JWKS signature, issuer, audience, expiration and nonce", async () => {
  const http = (async () => Response.json({ keys: [jwk] })) as typeof fetch;
  const verified = await verifyOpenAiIdToken(jwt("oaiapp_one", "nonce-1", "subject-1"), "oaiapp_one", "nonce-1", http);
  assert.equal(verified.subject, "subject-1");
  await assert.rejects(verifyOpenAiIdToken(jwt("oaiapp_one", "nonce-1", "subject-1"), "oaiapp_other", "nonce-1", http), /INVALID_ID_TOKEN/);
  await assert.rejects(verifyOpenAiIdToken(jwt("oaiapp_one", "nonce-1", "subject-1"), "oaiapp_one", "other", http), /INVALID_ID_TOKEN/);
  const signed = jwt("oaiapp_one", "nonce-1", "subject-1");
  const forged = `${signed.split(".")[0]}.${Buffer.from(JSON.stringify({ iss: "https://auth.openai.com", aud: "oaiapp_one", sub: "forged", nonce: "nonce-1", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.${signed.split(".")[2]}`;
  await assert.rejects(verifyOpenAiIdToken(forged, "oaiapp_one", "nonce-1", http), /INVALID_ID_TOKEN/);
});

test("new registration retains host ID, verifies identity, and stores credentials privately", async () => withRoot(async (root) => {
  let opened = "";
  const requests: URLSearchParams[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (String(url).endsWith("/token")) {
      const form = new URLSearchParams(String(init?.body)); requests.push(form);
      return Response.json({ access_token: "access-one", refresh_token: "refresh-one", id_token: jwt(form.get("client_id")!, new URL(opened).searchParams.get("nonce")!, "subject-one"),
        scope: GRANTS, token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  try {
    const job = await manager.startSignIn();
    const authorize = new URL(opened);
    assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
    assert.match(authorize.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
    assert.equal(authorize.searchParams.get("agent_name_hint"), "ChatGPT Codex Multi Account Switcher");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("scope"), GRANTS);
    const invalid = new URL(authorize.searchParams.get("redirect_uri")!);
    invalid.searchParams.set("state", "wrong"); invalid.searchParams.set("code", "code"); invalid.searchParams.set("client_id", "oaiapp_one");
    assert.equal((await fetch(invalid)).status, 400);
    assert.equal(manager.status(job.jobId).state, "pending");
    invalid.searchParams.set("state", authorize.searchParams.get("state")!);
    assert.equal((await fetch(invalid)).status, 200);
    await waitFor(manager, job.jobId);
    assert.equal(manager.status(job.jobId).state, "succeeded");
    const [account] = await manager.listAccounts();
    assert.equal(account.clientId, "oaiapp_one");
    assert.equal(account.subject, "subject-one");
    assert.equal(await manager.getAccessToken(account.id), "access-one");
    assert.equal(requests[0].get("client_id"), "oaiapp_one");
    assert.equal(requests[0].get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
    assert.equal(requests[0].get("code_verifier")?.length, 86);
    assert.equal(createHash("sha256").update(requests[0].get("code_verifier")!).digest("base64url"), authorize.searchParams.get("code_challenge"));
    const file = join(root, "codex", "credentials.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "codex"))).mode & 0o777, 0o700);
    assert.match(await readFile(file, "utf8"), /refresh-one/);
    assert.equal(JSON.stringify(account).includes("refresh-one"), false);
    const again = await manager.startSignIn(account.id);
    const returning = new URL(opened);
    assert.equal(returning.searchParams.get("client_id"), "oaiapp_one");
    assert.equal(returning.searchParams.get("agent_name_hint"), null);
    assert.equal(returning.searchParams.get("ext_agent_host_id"), authorize.searchParams.get("ext_agent_host_id"));
    manager.dispose();
    assert.equal(manager.status(again.jobId).state, "failed");
  } finally { manager.dispose(); }
}));

test("refresh serializes concurrent calls, persists the rotating token and disconnects locally", async () => withRoot(async (root) => {
  let opened = "";
  let refreshCalls = 0;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (address.endsWith("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/revoke" });
    if (address.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (address.endsWith("/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshCalls++;
        assert.equal(form.get("refresh_token"), "refresh-one");
        assert.equal(form.has("scope"), false);
        return Response.json({ access_token: "access-two", refresh_token: "refresh-two", scope: GRANTS, token_type: "Bearer", expires_in: 3600 });
      }
      return Response.json({ access_token: "access-one", refresh_token: "refresh-one", id_token: jwt("oaiapp_one", new URL(opened).searchParams.get("nonce")!, "subject-one"),
        scope: GRANTS, token_type: "Bearer", expires_in: 1 });
    }
    throw new Error("unexpected request");
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  try {
    const job = await manager.startSignIn();
    const callback = new URL(new URL(opened).searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", new URL(opened).searchParams.get("state")!);
    callback.searchParams.set("client_id", "oaiapp_one"); callback.searchParams.set("code", "code");
    await fetch(callback); await waitFor(manager, job.jobId);
    assert.equal(manager.status(job.jobId).state, "succeeded");
    const id = manager.status(job.jobId).accountId!;
    assert.deepEqual(await Promise.all([manager.getAccessToken(id), manager.getAccessToken(id)]), ["access-two", "access-two"]);
    assert.equal(refreshCalls, 1);
    assert.match(await readFile(join(root, "codex", "credentials.json"), "utf8"), /refresh-two/);
    assert.deepEqual(await manager.disconnect(id), { revokedAtOpenAI: true });
    assert.equal((await manager.listAccounts())[0].connected, false);
    await assert.rejects(manager.getAccessToken(id), /RECONNECT_REQUIRED/);
  } finally { manager.dispose(); }
}));

test("rejects missing plan scope and leaves no connected account", async () => withRoot(async (root) => {
  let opened = "";
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: "access", refresh_token: "refresh", id_token: jwt(form.get("client_id")!, new URL(opened).searchParams.get("nonce")!, "subject"),
      scope: "openid email", token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  try {
    const job = await manager.startSignIn();
    const callback = new URL(new URL(opened).searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", new URL(opened).searchParams.get("state")!);
    callback.searchParams.set("client_id", "oaiapp_one"); callback.searchParams.set("code", "code");
    await fetch(callback); await waitFor(manager, job.jobId);
    assert.equal(manager.status(job.jobId).errorCode, "CODEX_AUTH_SCOPE_MISSING");
    assert.deepEqual(await manager.listAccounts(), []);
  } finally { manager.dispose(); }
}));

test("separate registrations retain distinct identity and reject a mismatched reconnect", async () => withRoot(async (root) => {
  let opened = "";
  let issued = "oaiapp_alpha";
  let subject = "alpha";
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: `access-${subject}`, refresh_token: `refresh-${subject}`,
      id_token: jwt(form.get("client_id")!, new URL(opened).searchParams.get("nonce")!, subject),
      scope: GRANTS, token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  async function complete(existingId?: string) {
    const job = await manager.startSignIn(existingId);
    const authorize = new URL(opened);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "code");
    callback.searchParams.set("client_id", issued);
    await fetch(callback); await waitFor(manager, job.jobId);
    return manager.status(job.jobId);
  }
  try {
    const alpha = await complete();
    assert.equal(alpha.state, "succeeded");
    issued = "oaiapp_beta"; subject = "beta";
    const beta = await complete();
    assert.equal(beta.state, "succeeded");
    assert.notEqual(alpha.accountId, beta.accountId);
    assert.equal((await manager.listAccounts()).length, 2);
    assert.equal(await manager.getAccessToken(alpha.accountId!), "access-alpha");
    assert.equal(await manager.getAccessToken(beta.accountId!), "access-beta");
    issued = "oaiapp_alpha";
    const mismatch = await complete(alpha.accountId);
    assert.equal(mismatch.errorCode, "CODEX_AUTH_ACCOUNT_MISMATCH");
    assert.equal(await manager.getAccessToken(alpha.accountId!), "access-alpha");
    assert.equal((await manager.listAccounts()).length, 2);
  } finally { manager.dispose(); }
}));

test("retains issued client ID after failed code exchange and retries that registration safely", async () => withRoot(async (root) => {
  let opened = "";
  let exchanges = 0;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    exchanges++;
    if (exchanges === 1) return Response.json({ error: "invalid_grant", token: "must-never-be-shown" }, { status: 400 });
    return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret",
      id_token: jwt(form.get("client_id")!, new URL(opened).searchParams.get("nonce")!, "subject"),
      scope: GRANTS, token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  async function returnFromBrowser(includeClientId: boolean): Promise<void> {
    const authorize = new URL(opened);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "one-time-code");
    if (includeClientId) callback.searchParams.set("client_id", "oaiapp_issued");
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes("one-time-code"), false);
  }
  try {
    const first = await manager.startSignIn();
    assert.equal(new URL(opened).searchParams.get("client_id"), "dynamic_agent_client");
    await returnFromBrowser(true);
    await waitFor(manager, first.jobId);
    const failed = manager.status(first.jobId);
    assert.equal(failed.errorCode, "CODEX_AUTH_RECONNECT_REQUIRED");
    assert.ok(failed.registrationId);
    assert.equal(JSON.stringify(failed).includes("must-never-be-shown"), false);
    assert.equal((await manager.listPendingRegistrations())[0].registrationId, failed.registrationId);
    const retry = await manager.startSignIn(failed.registrationId);
    const retryUrl = new URL(opened);
    assert.equal(retryUrl.searchParams.get("client_id"), "oaiapp_issued");
    assert.equal(retryUrl.searchParams.get("agent_name_hint"), null);
    assert.equal(retry.registrationId, failed.registrationId);
    await returnFromBrowser(false);
    await waitFor(manager, retry.jobId);
    assert.equal(manager.status(retry.jobId).state, "succeeded");
    assert.equal((await manager.listAccounts())[0].clientId, "oaiapp_issued");
    assert.deepEqual(await manager.listPendingRegistrations(), []);
  } finally { manager.dispose(); }
}));

test("browser opener failures do not expose authorization URL or retained ID-token hints", async () => withRoot(async (root) => {
  const secret = "id-token-hint-secret";
  const file = join(root, "codex", "credentials.json");
  // A previously connected account is reauthorized using an ID-token hint.
  const boot = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher",
    openAuthorizationUrl: async () => undefined,
    fetch: (async () => Response.json({ keys: [jwk] })) as typeof fetch });
  await boot.listAccounts();
  boot.dispose();
  const initial = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  initial.accounts = [{ id: "123e4567-e89b-42d3-a456-426614174000", label: "One", issuer: "https://auth.openai.com",
    subject: "one", email: "one@example.test", clientId: "oaiapp_one", idToken: secret,
    accessToken: "access-secret", refreshToken: "refresh-secret", scopes: GRANTS.split(" "), expiresAt: Date.now() + 3600_000 }];
  await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher",
    openAuthorizationUrl: async (url) => { assert.equal(new URL(url).searchParams.get("id_token_hint"), secret); throw new Error(url); } });
  try {
    await assert.rejects(manager.startSignIn("123e4567-e89b-42d3-a456-426614174000"), (error: unknown) => {
      assert.equal((error as Error).message, "CODEX_AUTH_BROWSER_FAILED");
      assert.equal((error as Error).message.includes(secret), false);
      return true;
    });
  } finally { manager.dispose(); }
}));

test("rejects two issued clients for the same verified OpenAI subject", async () => withRoot(async (root) => {
  let opened = "";
  let issuedClientId = "oaiapp_first";
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: `access-${issuedClientId}`, refresh_token: `refresh-${issuedClientId}`,
      id_token: jwt(form.get("client_id")!, new URL(opened).searchParams.get("nonce")!, "same-subject"),
      scope: GRANTS, token_type: "Bearer", expires_in: 3600 });
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  async function complete() {
    const job = await manager.startSignIn();
    const authorize = new URL(opened);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("client_id", issuedClientId);
    callback.searchParams.set("code", "one-time-code");
    await fetch(callback); await waitFor(manager, job.jobId);
    return manager.status(job.jobId);
  }
  try {
    const first = await complete();
    assert.equal(first.state, "succeeded");
    issuedClientId = "oaiapp_second";
    const second = await complete();
    assert.equal(second.state, "failed");
    assert.equal(second.errorCode, "CODEX_AUTH_DUPLICATE_IDENTITY");
    assert.equal((await manager.listAccounts()).length, 1);
    assert.equal((await manager.listAccounts())[0].clientId, "oaiapp_first");
    assert.deepEqual(await manager.listPendingRegistrations(), []);
    assert.equal(await manager.getAccessToken(first.accountId!), "access-oaiapp_first");
  } finally { manager.dispose(); }
}));

test("verified unauthorized response forces one rotating refresh before nominal expiry", async () => withRoot(async (root) => {
  let opened = "";
  let refreshCalls = 0;
  let signalRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { signalRefreshStarted = resolve; });
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "refresh_token") {
      refreshCalls++;
      signalRefreshStarted();
      assert.equal(form.get("client_id"), "oaiapp_one");
      assert.equal(form.get("refresh_token"), "refresh-one");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", scope: GRANTS, expires_in: 3600 });
    }
    return Response.json({ access_token: "access-one", refresh_token: "refresh-one",
      id_token: jwt("oaiapp_one", new URL(opened).searchParams.get("nonce")!, "subject-one"),
      token_type: "Bearer", scope: GRANTS, expires_in: 3600 });
  }) as typeof fetch;
  const manager = createCodexAuthManager({ dataRoot: root, appName: "ChatGPT Codex Multi Account Switcher", openAuthorizationUrl: async (url) => { opened = url; }, fetch: http });
  try {
    const job = await manager.startSignIn();
    const authorize = new URL(opened);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("client_id", "oaiapp_one");
    callback.searchParams.set("code", "one-time-code");
    await fetch(callback); await waitFor(manager, job.jobId);
    const accountId = manager.status(job.jobId).accountId!;
    assert.equal(await manager.getAccessToken(accountId), "access-one");
    assert.equal(refreshCalls, 0);
    const first = manager.refreshAfterUnauthorized(accountId, "access-one");
    await refreshStarted;
    assert.deepEqual(await Promise.all([
      first,
      manager.refreshAfterUnauthorized(accountId, "access-one"),
      manager.getAccessToken(accountId),
    ]), ["access-two", "access-two", "access-two"]);
    assert.equal(refreshCalls, 1);
    assert.equal(await manager.refreshAfterUnauthorized(accountId, "access-one"), "access-two");
    assert.equal(refreshCalls, 1);
    assert.equal(await manager.getAccessToken(accountId), "access-two");
    const stored = await readFile(join(root, "codex", "credentials.json"), "utf8");
    assert.match(stored, /refresh-two/);
    assert.equal(stored.includes("refresh-one"), false);
  } finally { manager.dispose(); }
}));
