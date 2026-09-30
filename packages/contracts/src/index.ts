export const PROTOCOL_VERSION = 1 as const;
export const HOST_NAME = "com.chatgptcodexswitcher.bridge" as const;

export interface CodexAccountView { id: string; label: string; email: string | null; connected: boolean; expiresAt: number | null }
export interface CodexModelView { slug: string; displayName: string }
export interface CodexSignInView {
  jobId: string; state: "pending" | "succeeded" | "failed"; accountId?: string; registrationId?: string; errorCode?: string;
}
export interface CodexSessionView {
  id: string; title: string; cwd: string; model: string; threadId: string | null;
  activeAccountId: string; accountOrder: string[]; autoSwitch: boolean;
  status: "ready" | "running" | "switching" | "paused"; createdAt: string; updatedAt: string;
}
export interface CodexTurnView {
  id: string; sessionId: string; accountId: string; providerTurnId: string | null;
  userText: string; assistantText: string; status: "queued" | "running" | "completed" | "failed" | "interrupted";
  sideEffectsSeen: boolean; attempts: number; errorCode: string | null; createdAt: string; completedAt: string | null;
}
export interface CodexEventView {
  seq: number; sessionId: string; turnId: string | null; method: string; payload: unknown; createdAt: string;
}

export interface CommandPayloads {
  "codex.accounts.list": Record<string, never>;
  "codex.auth.pending": Record<string, never>;
  "codex.auth.start": { accountId?: string };
  "codex.auth.status": { jobId: string };
  "codex.auth.disconnect": { accountId: string };
  "codex.models.list": { accountId: string };
  "codex.sessions.list": Record<string, never>;
  "codex.sessions.create": { title: string; cwd: string; model: string; accountOrder: string[]; autoSwitch: boolean };
  "codex.sessions.get": { sessionId: string };
  "codex.sessions.switch": { sessionId: string; accountId: string };
  "codex.turns.list": { sessionId: string };
  "codex.turns.start": { sessionId: string; text: string };
  "codex.turns.interrupt": { sessionId: string };
  "codex.events.list": { sessionId: string; afterSeq: number };
  "codex.events.recent": { sessionId: string };
  "codex.approvals.list": { sessionId: string };
  "codex.approvals.resolve": { sessionId: string; approvalId: string | number; decision: "accept" | "decline" };
}

export type CommandType = keyof CommandPayloads;
export type CommandRequest<T extends CommandType = CommandType> = {
  [K in T]: { v: typeof PROTOCOL_VERSION; requestId: string; type: K; payload: CommandPayloads[K] };
}[T];
export type CommandResponse<T = unknown> =
  | { v: typeof PROTOCOL_VERSION; requestId: string; ok: true; data: T }
  | { v: typeof PROTOCOL_VERSION; requestId: string; ok: false; error: { code: string; message: string } };
