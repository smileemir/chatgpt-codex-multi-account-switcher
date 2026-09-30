import { PROTOCOL_VERSION, type CommandRequest, type CommandType } from "../../../../packages/contracts/src/index.ts";

export class ProtocolError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
const commands = new Set<CommandType>([
  "codex.accounts.list", "codex.auth.pending", "codex.auth.start", "codex.auth.status", "codex.auth.disconnect", "codex.models.list",
  "codex.sessions.list", "codex.sessions.create", "codex.sessions.get", "codex.sessions.switch",
  "codex.turns.list", "codex.turns.start", "codex.turns.interrupt", "codex.events.list", "codex.events.recent", "codex.approvals.list", "codex.approvals.resolve",
]);
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolError("BAD_REQUEST", "Invalid request body."); return value as Record<string, unknown>; }
function only(value: Record<string, unknown>, names: readonly string[]): void { if (Object.keys(value).some((key) => !names.includes(key))) throw new ProtocolError("BAD_REQUEST", "Unexpected request field."); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function string(value: unknown, max: number, allowEmpty = false): value is string { return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0); }
function requireUuid(value: unknown): void { if (!uuid(value)) throw new ProtocolError("BAD_REQUEST", "Invalid identifier."); }
function validatePayload(type: CommandType, payload: Record<string, unknown>): void {
  switch (type) {
    case "codex.accounts.list": case "codex.auth.pending": case "codex.sessions.list": only(payload, []); return;
    case "codex.auth.start": only(payload, ["accountId"]); if (payload.accountId !== undefined) requireUuid(payload.accountId); return;
    case "codex.auth.status": only(payload, ["jobId"]); requireUuid(payload.jobId); return;
    case "codex.auth.disconnect": case "codex.models.list": only(payload, ["accountId"]); requireUuid(payload.accountId); return;
    case "codex.sessions.create":
      only(payload, ["title", "cwd", "model", "accountOrder", "autoSwitch"]);
      if (!string(payload.title, 120) || !string(payload.cwd, 4096) || !string(payload.model, 120) || !Array.isArray(payload.accountOrder) || payload.accountOrder.length < 1 || payload.accountOrder.length > 20 || payload.accountOrder.some((id) => !uuid(id)) || new Set(payload.accountOrder).size !== payload.accountOrder.length || typeof payload.autoSwitch !== "boolean") throw new ProtocolError("BAD_REQUEST", "Invalid request parameters.");
      return;
    case "codex.sessions.get": case "codex.turns.list": case "codex.turns.interrupt": case "codex.approvals.list": case "codex.events.recent": only(payload, ["sessionId"]); requireUuid(payload.sessionId); return;
    case "codex.sessions.switch": only(payload, ["sessionId", "accountId"]); requireUuid(payload.sessionId); requireUuid(payload.accountId); return;
    case "codex.turns.start": only(payload, ["sessionId", "text"]); requireUuid(payload.sessionId); if (!string(payload.text, 64_000)) throw new ProtocolError("BAD_REQUEST", "Invalid request parameters."); return;
    case "codex.events.list": only(payload, ["sessionId", "afterSeq"]); requireUuid(payload.sessionId); if (!Number.isSafeInteger(payload.afterSeq) || (payload.afterSeq as number) < 0) throw new ProtocolError("BAD_REQUEST", "Invalid request parameters."); return;
    case "codex.approvals.resolve": only(payload, ["sessionId", "approvalId", "decision"]); requireUuid(payload.sessionId); if (!(typeof payload.approvalId === "number" && Number.isSafeInteger(payload.approvalId) && payload.approvalId >= 0) && !(typeof payload.approvalId === "string" && string(payload.approvalId, 120))) throw new ProtocolError("BAD_REQUEST", "Invalid request parameters."); if (payload.decision !== "accept" && payload.decision !== "decline") throw new ProtocolError("BAD_REQUEST", "Invalid request parameters."); return;
  }
  throw new ProtocolError("UNKNOWN_COMMAND", "Unsupported command.");
}
export function validateRequest(input: unknown): CommandRequest {
  const request = object(input); only(request, ["v", "requestId", "type", "payload"]);
  if (request.v !== PROTOCOL_VERSION) throw new ProtocolError("PROTOCOL_VERSION", "The extension and helper versions differ.");
  requireUuid(request.requestId); if (typeof request.type !== "string" || !commands.has(request.type as CommandType)) throw new ProtocolError("UNKNOWN_COMMAND", "Unsupported command.");
  const payload = object(request.payload); validatePayload(request.type as CommandType, payload); return request as unknown as CommandRequest;
}
