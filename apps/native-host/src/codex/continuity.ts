import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { CodexRuntime } from "./runtime.ts";
import { CodexSessionStore, type CodexSession, type CodexTurn } from "./store.ts";

type RuntimeEvent = { method: string; params: unknown };

export interface ContinuityAccountProvider {
  listAccounts(): Promise<Array<{ id: string; connected: boolean }>> | Array<{ id: string; connected: boolean }>;
  getAccessToken(accountId: string): Promise<string>;
  refreshAfterUnauthorized?(accountId: string, rejectedAccessToken: string): Promise<string>;
}

export interface ContinuityRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(input: { cwd: string; model: string }): Promise<string>;
  resumeThread(threadId: string, cwd: string, model: string): Promise<void>;
  startTurn(threadId: string, text: string): Promise<{ turnId: string; completed: Promise<Record<string, unknown>> }>;
  respondToApproval(id: number | string, decision: "accept" | "decline"): void;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  isAvailable?(): boolean;
}

export class CodexContinuityError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface CodexContinuityOptions {
  store: CodexSessionStore;
  accounts: ContinuityAccountProvider;
  codexExecutable: string;
  codexHome: string;
  runtimeFactory?: (token: string, onEvent: (event: RuntimeEvent) => void) => ContinuityRuntime;
}

type ActiveRuntime = { accountId: string; token: string; runtime: ContinuityRuntime; turnId: string | null; providerTurnId: string | null };

function limitError(turn: Record<string, unknown>): boolean {
  const error = turn.error as { codexErrorInfo?: unknown; message?: unknown } | undefined;
  const info = error?.codexErrorInfo;
  return info === "usageLimitExceeded" ||
    (typeof error?.message === "string" && error.message.includes("subscription_sharing_usage_limit_exceeded"));
}

function unauthorizedError(turn: Record<string, unknown>): boolean {
  const error = turn.error as { codexErrorInfo?: unknown } | undefined;
  return error?.codexErrorInfo === "unauthorized";
}

function sideEffectEvent(event: RuntimeEvent): boolean {
  if (event.method !== "item/started" && event.method !== "item/completed") return false;
  const item = (event.params as { item?: { type?: string } } | undefined)?.item;
  return ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item?.type ?? "");
}

export class CodexContinuityManager {
  private readonly active = new Map<string, ActiveRuntime>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly limited = new Map<string, Set<string>>();
  private readonly approvals = new Map<string, Array<{ id: number | string; method: string; params: unknown }>>();

  constructor(private readonly options: CodexContinuityOptions) {}

  private async locked<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(sessionId, current);
    try { return await current; }
    finally { if (this.locks.get(sessionId) === current) this.locks.delete(sessionId); }
  }

  private runtime(token: string, onEvent: (event: RuntimeEvent) => void): ContinuityRuntime {
    if (!this.options.runtimeFactory && !this.options.codexExecutable) {
      throw new CodexContinuityError("CODEX_CLI_NOT_FOUND", "Install Codex CLI to run coding sessions.");
    }
    return this.options.runtimeFactory?.(token, onEvent) ?? new CodexRuntime({
      executable: this.options.codexExecutable,
      codexHome: this.options.codexHome,
      accessToken: token,
      onEvent,
    });
  }

  async createSession(input: { title: string; cwd: string; model: string; accountOrder: string[]; autoSwitch: boolean }): Promise<CodexSession> {
    if (!this.options.runtimeFactory && !this.options.codexExecutable) {
      throw new CodexContinuityError("CODEX_CLI_NOT_FOUND", "Install Codex CLI to run coding sessions.");
    }
    const available = new Set((await this.options.accounts.listAccounts()).filter((account) => account.connected).map((account) => account.id));
    if (input.accountOrder.some((accountId) => !available.has(accountId))) {
      throw new CodexContinuityError("ACCOUNT_NOT_CONNECTED", "Connect every selected Codex account before creating a session.");
    }
    if (!path.isAbsolute(input.cwd)) throw new CodexContinuityError("INVALID_WORKSPACE", "Choose an absolute workspace directory.");
    const actual = await realpath(input.cwd);
    const status = await lstat(actual);
    if (!status.isDirectory() || (process.getuid && status.uid !== process.getuid())) {
      throw new CodexContinuityError("INVALID_WORKSPACE", "Choose a workspace directory owned by this user.");
    }
    const created = this.options.store.createSession({ ...input, cwd: actual, activeAccountId: input.accountOrder[0] });
    try {
      await this.locked(created.id, async () => { await this.ensureRuntime(created); });
      return this.options.store.getSession(created.id);
    } catch (error) {
      this.options.store.updateSession(created.id, { status: "paused" });
      this.options.store.appendEvent(created.id, null, "session/startFailed", { code: error instanceof CodexContinuityError ? error.code : "RUNTIME_FAILED" });
      throw error;
    }
  }

  private recordEvent(sessionId: string, event: RuntimeEvent): void {
    const active = this.active.get(sessionId);
    const turnId = active?.turnId ?? null;
    if (!turnId) return;
    if (event.method === "approval/requested") {
      const request = event.params as { id?: number | string; method?: string; params?: unknown };
      if ((typeof request.id === "number" || typeof request.id === "string") && typeof request.method === "string") {
        const pending = this.approvals.get(sessionId) ?? [];
        pending.push({ id: request.id, method: request.method, params: request.params });
        this.approvals.set(sessionId, pending);
      }
    }
    if (event.method === "item/agentMessage/delta") {
      const delta = (event.params as { delta?: unknown } | undefined)?.delta;
      if (typeof delta === "string") this.options.store.appendAssistantText(turnId, delta);
    }
    if (sideEffectEvent(event)) this.options.store.markSideEffect(turnId);
    const serialized = JSON.stringify(event.params ?? null);
    if ((event.method.startsWith("item/") || event.method.startsWith("turn/") || event.method === "approval/requested") &&
      Buffer.byteLength(serialized, "utf8") <= 512 * 1024) {
      this.options.store.appendEvent(sessionId, turnId, event.method, event.params);
    }
  }

  private async ensureRuntime(session: CodexSession): Promise<ActiveRuntime> {
    const present = this.active.get(session.id);
    const token = await this.options.accounts.getAccessToken(session.activeAccountId);
    if (present?.accountId === session.activeAccountId && present.token === token && present.runtime.isAvailable?.() !== false) return present;
    if (present?.turnId) throw new CodexContinuityError("TURN_ACTIVE", "Wait for the current Codex turn to finish.");
    if (present) { await present.runtime.stop(); this.active.delete(session.id); this.approvals.delete(session.id); }
    const runtime = this.runtime(token, (event) => this.recordEvent(session.id, event));
    try {
      await runtime.start();
      let threadId = session.threadId;
      if (threadId && this.options.store.listTurns(session.id).some((turn) => turn.attempts > 0)) await runtime.resumeThread(threadId, session.cwd, session.model);
      else {
        threadId = await runtime.startThread({ cwd: session.cwd, model: session.model });
        this.options.store.updateSession(session.id, { threadId });
      }
      const result: ActiveRuntime = { accountId: session.activeAccountId, token, runtime, turnId: null, providerTurnId: null };
      this.active.set(session.id, result);
      return result;
    } catch (error) {
      await runtime.stop();
      throw error;
    }
  }

  async switchAccount(sessionId: string, accountId: string): Promise<CodexSession> {
    return this.locked(sessionId, async () => this.switchUnlocked(sessionId, accountId));
  }

  private async switchUnlocked(sessionId: string, accountId: string): Promise<CodexSession> {
    const session = this.options.store.getSession(sessionId);
    if (!session.accountOrder.includes(accountId)) throw new CodexContinuityError("ACCOUNT_OUT_OF_POOL", "This account is not in the session pool.");
    if (session.activeAccountId === accountId) return session;
    const previous = this.active.get(session.id);
    if (previous?.turnId || session.status === "running") throw new CodexContinuityError("TURN_ACTIVE", "Wait for the current Codex turn to finish.");
    const token = await this.options.accounts.getAccessToken(accountId);
    this.options.store.updateSession(session.id, { status: "switching" });
    if (previous) {
      await previous.runtime.stop();
      this.active.delete(session.id);
      this.approvals.delete(session.id);
    }
    const runtime = this.runtime(token, (event) => this.recordEvent(session.id, event));
    try {
      await runtime.start();
      if (!this.options.store.listTurns(session.id).some((turn) => turn.attempts > 0)) {
        const threadId = await runtime.startThread({ cwd: session.cwd, model: session.model });
        this.options.store.updateSession(session.id, { threadId });
      } else {
        if (!session.threadId) throw new CodexContinuityError("THREAD_MISSING", "The Codex thread is missing.");
        await runtime.resumeThread(session.threadId, session.cwd, session.model);
      }
      this.active.set(session.id, { accountId, token, runtime, turnId: null, providerTurnId: null });
      this.options.store.updateSession(session.id, { activeAccountId: accountId, status: "ready" });
      this.options.store.appendEvent(session.id, null, "account/switched", { from: session.activeAccountId, to: accountId });
      return this.options.store.getSession(session.id);
    } catch (error) {
      await runtime.stop();
      this.options.store.updateSession(session.id, { status: "paused" });
      this.options.store.appendEvent(session.id, null, "account/switchFailed", { from: session.activeAccountId, to: accountId });
      throw error;
    }
  }

  async startTurn(sessionId: string, text: string): Promise<CodexTurn> {
    return this.locked(sessionId, async () => {
      const session = this.options.store.getSession(sessionId);
      if (session.status === "running" || session.status === "switching") throw new CodexContinuityError("TURN_ACTIVE", "A Codex turn is already running.");
      const active = await this.ensureRuntime(session);
      const logical = this.options.store.createTurn(session.id, session.activeAccountId, text);
      active.turnId = logical.id;
      this.options.store.updateSession(session.id, { status: "running" });
      this.options.store.appendEvent(session.id, logical.id, "turn/queued", { accountId: session.activeAccountId });
      try {
        await this.runAttempt(session.id, logical.id, active);
      } catch (error) {
        active.turnId = null;
        this.options.store.finishTurn(logical.id, "failed", "RUNTIME_START_FAILED");
        this.options.store.updateSession(session.id, { status: "paused" });
        throw error;
      }
      return this.options.store.getTurn(logical.id);
    });
  }

  private async runAttempt(sessionId: string, turnId: string, active: ActiveRuntime): Promise<void> {
    const session = this.options.store.getSession(sessionId);
    const logical = this.options.store.getTurn(turnId);
    if (!session.threadId) throw new CodexContinuityError("THREAD_MISSING", "The Codex thread is missing.");
    if (logical.attempts > 0) this.options.store.resetTurnAttempt(turnId);
    const attempt = await active.runtime.startTurn(session.threadId, logical.userText);
    active.providerTurnId = attempt.turnId;
    this.options.store.markTurnRunning(turnId, active.accountId, attempt.turnId);
    void attempt.completed.then((result) => this.completeAttempt(sessionId, turnId, result)).catch(() => {
      const current = this.options.store.getTurn(turnId);
      if (current.status === "running") {
        this.options.store.finishTurn(turnId, "interrupted", "RUNTIME_EXITED");
        this.options.store.updateSession(sessionId, { status: "paused" });
        active.turnId = null;
        active.providerTurnId = null;
        this.approvals.delete(sessionId);
      }
    });
  }

  private async completeAttempt(sessionId: string, turnId: string, result: Record<string, unknown>): Promise<void> {
    await this.locked(sessionId, async () => {
      const session = this.options.store.getSession(sessionId);
      const active = this.active.get(sessionId);
      if (!active || active.turnId !== turnId) return;
      const status = result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : "failed";
      const limited = status === "failed" && limitError(result);
      const unauthorized = status === "failed" && unauthorizedError(result);
      const logical = this.options.store.getTurn(turnId);
      active.turnId = null;
      active.providerTurnId = null;
      this.approvals.delete(sessionId);
      if (unauthorized && logical.attempts === 1 && !logical.sideEffectsSeen && this.options.accounts.refreshAfterUnauthorized) {
        try {
          await this.options.accounts.refreshAfterUnauthorized(active.accountId, active.token);
          this.options.store.updateSession(sessionId, { status: "ready" });
          const restarted = await this.ensureRuntime(this.options.store.getSession(sessionId));
          restarted.turnId = turnId;
          this.options.store.updateSession(sessionId, { status: "running" });
          this.options.store.appendEvent(sessionId, turnId, "turn/authRetry", { accountId: active.accountId });
          await this.runAttempt(sessionId, turnId, restarted);
          return;
        } catch {
          const current = this.active.get(sessionId);
          if (current) { current.turnId = null; current.providerTurnId = null; }
          this.options.store.updateSession(sessionId, { status: "paused" });
        }
      }
      if (limited) {
        const marked = this.limited.get(sessionId) ?? new Set<string>();
        marked.add(active.accountId);
        this.limited.set(sessionId, marked);
        this.options.store.appendEvent(sessionId, turnId, "account/limitReached", { accountId: active.accountId });
        if (session.autoSwitch && !logical.sideEffectsSeen) {
          this.options.store.updateSession(sessionId, { status: "ready" });
          const start = session.accountOrder.indexOf(active.accountId);
          for (let offset = 1; offset < session.accountOrder.length; offset++) {
            const candidate = session.accountOrder[(start + offset) % session.accountOrder.length];
            if (marked.has(candidate)) continue;
            try {
              await this.switchUnlocked(sessionId, candidate);
              const next = this.active.get(sessionId)!;
              next.turnId = turnId;
              this.options.store.updateSession(sessionId, { status: "running" });
              this.options.store.appendEvent(sessionId, turnId, "turn/retrying", { accountId: candidate });
              await this.runAttempt(sessionId, turnId, next);
              return;
            } catch {
              const attempted = this.active.get(sessionId);
              if (attempted) { attempted.turnId = null; attempted.providerTurnId = null; }
              this.options.store.updateSession(sessionId, { status: "ready" });
              marked.add(candidate);
            }
          }
        }
      }
      this.options.store.finishTurn(turnId, status, limited ? "USAGE_LIMIT" : unauthorized ? "UNAUTHORIZED" : status === "completed" ? null : "TURN_FAILED");
      this.options.store.updateSession(sessionId, { status: status === "completed" ? "ready" : "paused" });
      this.limited.delete(sessionId);
    });
  }

  async resolveApproval(sessionId: string, id: number | string, decision: "accept" | "decline"): Promise<void> {
    const session = this.options.store.getSession(sessionId);
    const active = this.active.get(session.id);
    if (!active?.turnId) throw new CodexContinuityError("APPROVAL_NOT_FOUND", "There is no active approval for this session.");
    active.runtime.respondToApproval(id, decision);
    this.approvals.set(session.id, (this.approvals.get(session.id) ?? []).filter((request) => request.id !== id));
    this.options.store.appendEvent(session.id, active.turnId, "approval/resolved", { id, decision });
  }

  listApprovals(sessionId: string): Array<{ id: number | string; method: string; params: unknown }> {
    this.options.store.getSession(sessionId);
    return [...(this.approvals.get(sessionId) ?? [])];
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const sessions = this.options.store.listSessions();
    for (const session of sessions) {
      const active = this.active.get(session.id);
      if (active?.accountId !== accountId) continue;
      if (active.turnId) throw new CodexContinuityError("CODEX_ACCOUNT_IN_USE", "Stop the active Codex turn before disconnecting this account.");
      await active.runtime.stop();
      this.active.delete(session.id);
      this.approvals.delete(session.id);
      this.options.store.updateSession(session.id, { status: "paused" });
      this.options.store.appendEvent(session.id, null, "account/disconnected", { accountId });
    }
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const session = this.options.store.getSession(sessionId);
    const active = this.active.get(session.id);
    if (!session.threadId || !active?.providerTurnId) throw new CodexContinuityError("TURN_NOT_RUNNING", "No Codex turn is running.");
    await active.runtime.interruptTurn(session.threadId, active.providerTurnId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map((active) => active.runtime.stop()));
    this.active.clear();
    this.approvals.clear();
  }
}
