import type { CommandRequest } from "../../../packages/contracts/src/index.ts";
import type { CodexAuthManager } from "./codex/auth.ts";
import type { CodexContinuityManager } from "./codex/continuity.ts";
import type { CodexSessionStore } from "./codex/store.ts";
import { listCodexModels } from "./codex/models.ts";

export interface CodexDispatcherDependencies { auth: CodexAuthManager; store: CodexSessionStore; continuity: CodexContinuityManager; }
export function createDispatcher(deps: CodexDispatcherDependencies) {
  return async (request: CommandRequest): Promise<unknown> => {
    const { auth, store, continuity } = deps;
    switch (request.type) {
      case "codex.accounts.list": return auth.listAccounts();
      case "codex.auth.pending": return auth.listPendingRegistrations();
      case "codex.auth.start": return auth.startSignIn(request.payload.accountId);
      case "codex.auth.status": return auth.status(request.payload.jobId);
      case "codex.auth.disconnect": await continuity.disconnectAccount(request.payload.accountId); return auth.disconnect(request.payload.accountId);
      case "codex.models.list": return listCodexModels(auth, request.payload.accountId);
      case "codex.sessions.list": return store.listSessions();
      case "codex.sessions.create": return continuity.createSession(request.payload);
      case "codex.sessions.get": return store.getSession(request.payload.sessionId);
      case "codex.sessions.switch": return continuity.switchAccount(request.payload.sessionId, request.payload.accountId);
      case "codex.turns.list": return store.listTurns(request.payload.sessionId);
      case "codex.turns.start": return continuity.startTurn(request.payload.sessionId, request.payload.text);
      case "codex.turns.interrupt": return continuity.interruptTurn(request.payload.sessionId);
      case "codex.events.list": return store.listEvents(request.payload.sessionId, request.payload.afterSeq);
      case "codex.events.recent": return store.listRecentEvents(request.payload.sessionId);
      case "codex.approvals.list": return continuity.listApprovals(request.payload.sessionId);
      case "codex.approvals.resolve": return continuity.resolveApproval(request.payload.sessionId, request.payload.approvalId, request.payload.decision);
    }
  };
}
