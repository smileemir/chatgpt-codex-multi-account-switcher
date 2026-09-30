import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

type RpcMessage = Record<string, unknown>;
type RuntimeEvent = { method: string; params: unknown };

export class CodexRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexRuntimeError";
  }
}

export interface CodexRuntimeOptions {
  executable: string;
  codexHome: string;
  accessToken: string;
  onEvent?: (event: RuntimeEvent) => void;
  spawnProcess?: typeof spawn;
  requestTimeoutMs?: number;
}

/** One app-server process represents one selected ChatGPT account. Thread files stay in one app-owned CODEX_HOME. */
export class CodexRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private readonly turns = new Map<string, {
    resolve: (value: RpcMessage) => void;
    reject: (error: Error) => void;
  }>();
  private readonly completedTurns = new Map<string, RpcMessage>();
  private readonly approvals = new Set<number | string>();
  private closed = false;

  constructor(private readonly options: CodexRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.child || this.closed) throw new CodexRuntimeError("RUNTIME_STATE", "Codex runtime is already used.");
    if (!path.isAbsolute(this.options.executable) || !path.isAbsolute(this.options.codexHome)) {
      throw new CodexRuntimeError("INVALID_RUNTIME_PATH", "Codex runtime paths must be absolute.");
    }
    if (!this.options.accessToken) throw new CodexRuntimeError("ACCOUNT_NOT_CONNECTED", "The selected account has no access token.");
    await mkdir(this.options.codexHome, { recursive: true, mode: 0o700 });
    const args = [
      "app-server", "--listen", "stdio://",
      "-c", 'model_provider="openai_chatgpt_plan"',
      "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      "-c", 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
      "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
      "-c", "shell_environment_policy.ignore_default_excludes=false",
      "-c", 'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME,
      USER: process.env.USER,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      CODEX_HOME: this.options.codexHome,
      ACCESS_TOKEN: this.options.accessToken,
    };
    const child = (this.options.spawnProcess ?? spawn)(this.options.executable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.on("data", () => { /* stderr may contain request details; never log it. */ });
    child.on("error", (error) => this.failAll(new CodexRuntimeError("RUNTIME_START_FAILED", error.message)));
    child.on("close", () => { this.closed = true; this.child = null; this.failAll(new CodexRuntimeError("RUNTIME_EXITED", "Codex runtime exited.")); });
    await this.request("initialize", {
      clientInfo: { name: "chatgpt_codex_multi_account_switcher", title: "ChatGPT Codex Multi Account Switcher", version: "0.1.0" },
      capabilities: null,
    });
    this.notify("initialized", {});
  }

  private read(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.failAll(new CodexRuntimeError("RUNTIME_RESPONSE_TOO_LARGE", "Codex returned an oversized event."));
      this.child?.kill("SIGTERM");
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { this.failAll(new CodexRuntimeError("RUNTIME_PROTOCOL", "Codex returned invalid JSON.")); return; }
      this.handle(message);
    }
  }

  private handle(message: RpcMessage): void {
    const id = message.id;
    if (typeof id === "number" && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const error = message.error as { message?: string; code?: string | number };
        pending.reject(new CodexRuntimeError(String(error.code ?? "RUNTIME_RPC_ERROR"), error.message ?? "Codex request failed."));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (typeof id === "number" || typeof id === "string") {
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "applyPatchApproval", "execCommandApproval"].includes(message.method)) {
        this.approvals.add(id);
        try { this.options.onEvent?.({ method: "approval/requested", params: { id, method: message.method, params: message.params } }); }
        catch { this.approvals.delete(id); this.write({ id, result: { decision: "decline" } }); }
      } else {
        this.write({ id, error: { code: -32601, message: "Unsupported app-server request." } });
      }
      return;
    }
    try { this.options.onEvent?.({ method: message.method, params: message.params }); }
    catch (error) { this.failAll(new CodexRuntimeError("EVENT_PERSIST_FAILED", error instanceof Error ? error.message : "Could not persist Codex event.")); return; }
    if (message.method === "turn/completed") {
      const params = message.params as { turn?: RpcMessage } | undefined;
      const turn = params?.turn;
      if (turn && typeof turn.id === "string") {
        const pending = this.turns.get(turn.id);
        if (pending) {
          this.turns.delete(turn.id);
          pending.resolve(turn);
        } else this.completedTurns.set(turn.id, turn);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.turns.values()) pending.reject(error);
    this.turns.clear();
  }

  private write(message: RpcMessage): void {
    if (!this.child || this.closed || !this.child.stdin.writable) {
      throw new CodexRuntimeError("RUNTIME_UNAVAILABLE", "Codex runtime is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRuntimeError("RUNTIME_TIMEOUT", `Codex ${method} timed out.`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  async startThread(input: { cwd: string; model: string }): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: input.cwd,
      model: input.model,
      modelProvider: "openai_chatgpt_plan",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    }) as { thread?: { id?: string } };
    if (!result?.thread?.id) throw new CodexRuntimeError("RUNTIME_PROTOCOL", "Codex returned no thread ID.");
    return result.thread.id;
  }

  async resumeThread(threadId: string, cwd: string, model: string): Promise<void> {
    const result = await this.request("thread/resume", {
      threadId, cwd, model, modelProvider: "openai_chatgpt_plan",
      approvalPolicy: "on-request", sandbox: "workspace-write", excludeTurns: true,
    }) as { thread?: { id?: string } };
    if (result?.thread?.id !== threadId) throw new CodexRuntimeError("RUNTIME_PROTOCOL", "Codex resumed a different thread.");
  }

  async startTurn(threadId: string, text: string): Promise<{ turnId: string; completed: Promise<RpcMessage> }> {
    const result = await this.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] }) as { turn?: { id?: string } };
    const turnId = result?.turn?.id;
    if (!turnId) throw new CodexRuntimeError("RUNTIME_PROTOCOL", "Codex returned no turn ID.");
    const early = this.completedTurns.get(turnId);
    if (early) this.completedTurns.delete(turnId);
    const completed = early
      ? Promise.resolve(early)
      : new Promise<RpcMessage>((resolve, reject) => this.turns.set(turnId, { resolve, reject }));
    return { turnId, completed };
  }

  respondToApproval(id: number | string, decision: "accept" | "decline"): void {
    if (!this.approvals.has(id)) throw new CodexRuntimeError("APPROVAL_NOT_FOUND", "Approval request was not found.");
    this.write({ id, result: { decision } });
    this.approvals.delete(id);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  isAvailable(): boolean { return this.child !== null && !this.closed; }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.failAll(new CodexRuntimeError("RUNTIME_STOPPED", "Codex runtime stopped."));
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
