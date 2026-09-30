import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexContinuityManager, type ContinuityRuntime } from "../apps/native-host/src/codex/continuity.ts";
import { CodexSessionStore } from "../apps/native-host/src/codex/store.ts";
import { prepareCodexRoot } from "./fixtures/codex-root.ts";

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Codex turn did not settle");
}

test("one logical Codex session keeps the same thread through A→B→C", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-switch-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const a = randomUUID(), b = randomUUID(), c = randomUUID();
  const resumed: Array<{ account: string; thread: string }> = [];
  const started: string[] = [];
  const accounts = new Map<string, string>([[a, "token-a"], [b, "token-b"], [c, "token-c"]]);
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: {
        listAccounts: () => [...accounts.keys()].map((id) => ({ id, connected: true })),
        getAccessToken: async (id) => accounts.get(id)!,
      },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "codex-home"),
      runtimeFactory: (token, onEvent) => {
        const account = [...accounts].find(([, value]) => value === token)![0];
        const runtime: ContinuityRuntime = {
          async start() { started.push(account); },
          async stop() {},
          async startThread() { return randomUUID(); },
          async resumeThread(thread) { resumed.push({ account, thread }); },
          async startTurn(threadId) {
            const turnId = randomUUID();
            const completed = Promise.resolve({ id: turnId, status: "completed" });
            queueMicrotask(() => onEvent({ method: "item/agentMessage/delta", params: { delta: `response-${account}` } }));
            return { turnId, completed };
          },
          respondToApproval() {},
          async interruptTurn() {},
        };
        return runtime;
      },
    });
    try {
      const session = await manager.createSession({ title: "Cross account", cwd: root, model: "test-model", accountOrder: [a, b, c], autoSwitch: true });
      assert.ok(session.threadId);
      await manager.startTurn(session.id, "first");
      await until(() => store.getSession(session.id).status === "ready");
      await manager.switchAccount(session.id, b);
      await manager.startTurn(session.id, "second");
      await until(() => store.getSession(session.id).status === "ready");
      await manager.switchAccount(session.id, c);
      await manager.startTurn(session.id, "third");
      await until(() => store.getSession(session.id).status === "ready");
      assert.deepEqual(started, [a, b, c]);
      assert.deepEqual(resumed, [{ account: b, thread: session.threadId }, { account: c, thread: session.threadId }]);
      assert.equal(store.getSession(session.id).activeAccountId, c);
      assert.deepEqual(store.listTurns(session.id).map((turn) => turn.accountId), [a, b, c]);
      assert.deepEqual(store.listTurns(session.id).map((turn) => turn.assistantText), [`response-${a}`, `response-${b}`, `response-${c}`]);
      assert.equal(store.listEvents(session.id).filter((event) => event.method === "account/switched").length, 2);
    } finally { await manager.close(); }
  } finally {
    store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("usage limit retries a turn on the next account when no side effect ran", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-limit-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const a = randomUUID(), b = randomUUID();
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: { listAccounts: () => [a, b].map((id) => ({ id, connected: true })), getAccessToken: async (id) => id },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "codex-home"),
      runtimeFactory: (account, onEvent) => ({
        async start() {}, async stop() {}, async startThread() { return randomUUID(); }, async resumeThread() {},
        async startTurn() {
          const turnId = randomUUID();
          if (account === b) queueMicrotask(() => onEvent({ method: "item/agentMessage/delta", params: { delta: "continued" } }));
          return { turnId, completed: Promise.resolve(account === a
            ? { id: turnId, status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } }
            : { id: turnId, status: "completed" }) };
        },
        respondToApproval() {}, async interruptTurn() {},
      }),
    });
    try {
      const session = await manager.createSession({ title: "Limit", cwd: root, model: "test-model", accountOrder: [a, b], autoSwitch: true });
      const turn = await manager.startTurn(session.id, "keep going");
      await until(() => store.getTurn(turn.id).status === "completed");
      assert.equal(store.getTurn(turn.id).accountId, b);
      assert.equal(store.getTurn(turn.id).attempts, 2);
      assert.equal(store.getTurn(turn.id).assistantText, "continued");
      assert.equal(store.getSession(session.id).activeAccountId, b);
    } finally { await manager.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("switch before first turn creates a fresh empty thread instead of resuming an unsaved rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-empty-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const a = randomUUID(), b = randomUUID();
  let started = 0;
  let resumed = 0;
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: { listAccounts: () => [a, b].map((id) => ({ id, connected: true })), getAccessToken: async (id) => id },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "home"),
      runtimeFactory: () => ({
        async start() {}, async stop() {}, async startThread() { started++; return randomUUID(); },
        async resumeThread() { resumed++; throw new Error("No rollout exists"); },
        async startTurn() { throw new Error("Unused"); }, respondToApproval() {}, async interruptTurn() {},
      }),
    });
    try {
      const session = await manager.createSession({ title: "Empty", cwd: root, model: "test-model", accountOrder: [a, b], autoSwitch: false });
      const switched = await manager.switchAccount(session.id, b);
      assert.equal(started, 2);
      assert.equal(resumed, 0);
      assert.notEqual(switched.threadId, session.threadId);
    } finally { await manager.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("unauthorized turn refreshes token, restarts runtime, and retries once without switching accounts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-auth-retry-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const a = randomUUID();
  let currentToken = "old-token";
  const launches: string[] = [];
  const rejected: string[] = [];
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: {
        listAccounts: () => [{ id: a, connected: true }],
        getAccessToken: async () => currentToken,
        refreshAfterUnauthorized: async (_id, token) => { rejected.push(token); currentToken = "new-token"; return currentToken; },
      },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "home"),
      runtimeFactory: (token, onEvent) => {
        launches.push(token);
        return {
          async start() {}, async stop() {}, async startThread() { return randomUUID(); }, async resumeThread() {},
          async startTurn() {
            const turnId = randomUUID();
            if (token === "new-token") queueMicrotask(() => onEvent({ method: "item/agentMessage/delta", params: { delta: "recovered" } }));
            return { turnId, completed: Promise.resolve(token === "old-token"
              ? { id: turnId, status: "failed", error: { codexErrorInfo: "unauthorized" } }
              : { id: turnId, status: "completed" }) };
          },
          respondToApproval() {}, async interruptTurn() {},
        };
      },
    });
    try {
      const session = await manager.createSession({ title: "Auth retry", cwd: root, model: "test-model", accountOrder: [a], autoSwitch: false });
      const turn = await manager.startTurn(session.id, "continue");
      await until(() => store.getTurn(turn.id).status === "completed");
      assert.deepEqual(launches, ["old-token", "new-token"]);
      assert.deepEqual(rejected, ["old-token"]);
      assert.equal(store.getTurn(turn.id).attempts, 2);
      assert.equal(store.getTurn(turn.id).assistantText, "recovered");
      assert.equal(store.getSession(session.id).threadId, session.threadId);
    } finally { await manager.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("usage limit after a command began pauses without automatically repeating the turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-side-effect-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const a = randomUUID(), b = randomUUID();
  let attempts = 0;
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: { listAccounts: () => [a, b].map((id) => ({ id, connected: true })), getAccessToken: async (id) => id },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "home"),
      runtimeFactory: (_token, onEvent) => ({
        async start() {}, async stop() {}, async startThread() { return randomUUID(); }, async resumeThread() {},
        async startTurn() {
          attempts++;
          const turnId = randomUUID();
          queueMicrotask(() => onEvent({ method: "item/started", params: { item: { type: "commandExecution", command: "true" } } }));
          return { turnId, completed: Promise.resolve({ id: turnId, status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } }) };
        },
        respondToApproval() {}, async interruptTurn() {},
      }),
    });
    try {
      const session = await manager.createSession({ title: "Side effect", cwd: root, model: "test-model", accountOrder: [a, b], autoSwitch: true });
      const turn = await manager.startTurn(session.id, "run command");
      await until(() => store.getTurn(turn.id).status === "failed");
      assert.equal(attempts, 1);
      assert.equal(store.getTurn(turn.id).sideEffectsSeen, true);
      assert.equal(store.getSession(session.id).activeAccountId, a);
      assert.equal(store.getSession(session.id).status, "paused");
    } finally { await manager.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("disconnecting an active account stops its runtime and pauses the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-disconnect-"));
  await prepareCodexRoot(root);
  const store = new CodexSessionStore(root);
  const account = randomUUID(); let stopped = 0;
  try {
    await store.initialize();
    const manager = new CodexContinuityManager({
      store, accounts: { listAccounts: () => [{ id: account, connected: true }], getAccessToken: async () => "token" },
      codexExecutable: "/fake/codex", codexHome: path.join(root, "home"),
      runtimeFactory: () => ({ async start() {}, async stop() { stopped++; }, async startThread() { return randomUUID(); }, async resumeThread() {}, async startTurn() { throw new Error("unused"); }, respondToApproval() {}, async interruptTurn() {} }),
    });
    try {
      const session = await manager.createSession({ title: "Disconnect", cwd: root, model: "model", accountOrder: [account], autoSwitch: false });
      await manager.disconnectAccount(account);
      assert.equal(stopped, 1);
      assert.equal(store.getSession(session.id).status, "paused");
    } finally { await manager.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
