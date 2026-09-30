import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function id(value: string): string {
  if (!UUID.test(value)) throw new CodexStoreError("INVALID_ID", "Invalid Codex identifier.");
  return value.toLowerCase();
}

export class CodexStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface CodexSession {
  id: string;
  title: string;
  cwd: string;
  model: string;
  threadId: string | null;
  activeAccountId: string;
  accountOrder: string[];
  autoSwitch: boolean;
  status: "ready" | "running" | "switching" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface CodexTurn {
  id: string;
  sessionId: string;
  accountId: string;
  providerTurnId: string | null;
  userText: string;
  assistantText: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  sideEffectsSeen: boolean;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CodexEvent {
  seq: number;
  sessionId: string;
  turnId: string | null;
  method: string;
  payload: unknown;
  createdAt: string;
}

type SessionRow = {
  id: string; title: string; cwd: string; model: string; thread_id: string | null;
  active_account_id: string; account_order: string; auto_switch: number; status: CodexSession["status"];
  created_at: string; updated_at: string;
};
type TurnRow = {
  id: string; session_id: string; account_id: string; provider_turn_id: string | null;
  user_text: string; assistant_text: string; status: CodexTurn["status"]; side_effects_seen: number;
  attempts: number; error_code: string | null; created_at: string; completed_at: string | null;
};

function session(row: SessionRow): CodexSession {
  return {
    id: row.id, title: row.title, cwd: row.cwd, model: row.model, threadId: row.thread_id,
    activeAccountId: row.active_account_id, accountOrder: JSON.parse(row.account_order) as string[],
    autoSwitch: !!row.auto_switch, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function turn(row: TurnRow): CodexTurn {
  return {
    id: row.id, sessionId: row.session_id, accountId: row.account_id, providerTurnId: row.provider_turn_id,
    userText: row.user_text, assistantText: row.assistant_text, status: row.status,
    sideEffectsSeen: !!row.side_effects_seen, attempts: row.attempts, errorCode: row.error_code,
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

export class CodexSessionStore {
  private db: DatabaseSync | null = null;
  constructor(private readonly dataRoot: string) {}

  async initialize(): Promise<void> {
    if (this.db) return;
    const filename = path.join(this.dataRoot, "database", "app.sqlite");
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw new CodexStoreError("UNSAFE_DATABASE_PATH", "The Codex database path is unsafe.");
    }
    await chmod(filename, 0o600);
    const db = new DatabaseSync(filename);
    this.db = db;
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS codex_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          cwd TEXT NOT NULL,
          model TEXT NOT NULL,
          thread_id TEXT,
          active_account_id TEXT NOT NULL,
          account_order TEXT NOT NULL,
          auto_switch INTEGER NOT NULL CHECK (auto_switch IN (0,1)),
          status TEXT NOT NULL CHECK (status IN ('ready','running','switching','paused')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS codex_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          provider_turn_id TEXT,
          user_text TEXT NOT NULL,
          assistant_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','interrupted')),
          side_effects_seen INTEGER NOT NULL DEFAULT 0 CHECK (side_effects_seen IN (0,1)),
          attempts INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS codex_turns_session_idx ON codex_turns(session_id, created_at);
        CREATE TABLE IF NOT EXISTS codex_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
          turn_id TEXT REFERENCES codex_turns(id) ON DELETE CASCADE,
          method TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS codex_events_session_idx ON codex_events(session_id, seq);
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
      `);
      db.exec("UPDATE codex_sessions SET status = 'paused' WHERE status IN ('running','switching');");
      db.exec("UPDATE codex_turns SET status = 'interrupted', completed_at = datetime('now') WHERE status = 'running';");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      this.db = null;
      throw error;
    }
  }

  close(): void { this.db?.close(); this.db = null; }
  private get connection(): DatabaseSync {
    if (!this.db) throw new CodexStoreError("DATABASE_NOT_READY", "Codex database is not initialized.");
    return this.db;
  }

  createSession(input: { title: string; cwd: string; model: string; activeAccountId: string; accountOrder: string[]; autoSwitch: boolean }): CodexSession {
    if (!input.title.trim() || input.title.length > 120 || !path.isAbsolute(input.cwd) || !input.model.trim()) {
      throw new CodexStoreError("INVALID_SESSION", "Codex session fields are invalid.");
    }
    const active = id(input.activeAccountId);
    const order = input.accountOrder.map(id);
    if (!order.length || order.length > 20 || new Set(order).size !== order.length || !order.includes(active)) {
      throw new CodexStoreError("INVALID_ACCOUNT_POOL", "Choose unique connected accounts for this session.");
    }
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO codex_sessions(id,title,cwd,model,thread_id,active_account_id,account_order,auto_switch,status,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,?,?,'ready',?,?)
    `).run(sessionId, input.title.trim(), input.cwd, input.model, active, JSON.stringify(order), input.autoSwitch ? 1 : 0, now, now);
    return this.getSession(sessionId);
  }

  listSessions(): CodexSession[] {
    return (this.connection.prepare("SELECT * FROM codex_sessions ORDER BY updated_at DESC").all() as unknown as SessionRow[]).map(session);
  }

  getSession(sessionId: string): CodexSession {
    const row = this.connection.prepare("SELECT * FROM codex_sessions WHERE id = ?").get(id(sessionId)) as SessionRow | undefined;
    if (!row) throw new CodexStoreError("SESSION_NOT_FOUND", "Codex session was not found.");
    return session(row);
  }

  updateSession(sessionId: string, patch: Partial<Pick<CodexSession, "threadId" | "activeAccountId" | "status">>): CodexSession {
    const current = this.getSession(sessionId);
    const account = patch.activeAccountId ? id(patch.activeAccountId) : current.activeAccountId;
    if (!current.accountOrder.includes(account)) throw new CodexStoreError("ACCOUNT_OUT_OF_POOL", "This account is not in the session pool.");
    const status = patch.status ?? current.status;
    if (!["ready", "running", "switching", "paused"].includes(status)) throw new CodexStoreError("INVALID_SESSION_STATUS", "Invalid Codex session status.");
    const threadId = patch.threadId === undefined ? current.threadId : patch.threadId;
    if (threadId !== null && !UUID.test(threadId)) throw new CodexStoreError("INVALID_THREAD_ID", "Invalid Codex thread ID.");
    this.connection.prepare("UPDATE codex_sessions SET thread_id = ?, active_account_id = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(threadId, account, status, new Date().toISOString(), current.id);
    return this.getSession(current.id);
  }

  createTurn(sessionId: string, accountId: string, text: string): CodexTurn {
    const current = this.getSession(sessionId);
    if (id(accountId) !== current.activeAccountId) throw new CodexStoreError("ACCOUNT_MISMATCH", "The turn account is not active for this session.");
    if (!text.trim() || text.length > 64_000) throw new CodexStoreError("INVALID_MESSAGE", "Enter a message up to 64,000 characters.");
    const turnId = randomUUID();
    this.connection.prepare(`INSERT INTO codex_turns(id,session_id,account_id,user_text,status,created_at)
      VALUES (?,?,?,?,'queued',?)`).run(turnId, current.id, accountId, text, new Date().toISOString());
    return this.getTurn(turnId);
  }

  getTurn(turnId: string): CodexTurn {
    const row = this.connection.prepare("SELECT * FROM codex_turns WHERE id = ?").get(id(turnId)) as TurnRow | undefined;
    if (!row) throw new CodexStoreError("TURN_NOT_FOUND", "Codex turn was not found.");
    return turn(row);
  }

  listTurns(sessionId: string): CodexTurn[] {
    this.getSession(sessionId);
    return (this.connection.prepare("SELECT * FROM codex_turns WHERE session_id = ? ORDER BY created_at, rowid")
      .all(id(sessionId)) as unknown as TurnRow[]).map(turn);
  }

  markTurnRunning(turnId: string, accountId: string, providerTurnId: string): CodexTurn {
    const current = this.getTurn(turnId);
    const account = id(accountId);
    if (!this.getSession(current.sessionId).accountOrder.includes(account)) throw new CodexStoreError("ACCOUNT_OUT_OF_POOL", "This account is not in the session pool.");
    this.connection.prepare(`UPDATE codex_turns SET account_id=?, provider_turn_id=?, status='running', attempts=attempts+1,
      error_code=NULL, completed_at=NULL WHERE id=?`)
      .run(account, providerTurnId, current.id);
    return this.getTurn(current.id);
  }

  resetTurnAttempt(turnId: string): void {
    this.connection.prepare("UPDATE codex_turns SET assistant_text='', side_effects_seen=0 WHERE id=?").run(id(turnId));
  }

  appendAssistantText(turnId: string, delta: string): void {
    if (delta.length > 128_000) throw new CodexStoreError("EVENT_TOO_LARGE", "Codex event is too large.");
    this.connection.prepare("UPDATE codex_turns SET assistant_text = assistant_text || ? WHERE id = ?")
      .run(delta, id(turnId));
  }

  markSideEffect(turnId: string): void {
    this.connection.prepare("UPDATE codex_turns SET side_effects_seen=1 WHERE id=?").run(id(turnId));
  }

  finishTurn(turnId: string, status: "completed" | "failed" | "interrupted", errorCode: string | null = null): CodexTurn {
    const current = this.getTurn(turnId);
    this.connection.prepare("UPDATE codex_turns SET status=?, error_code=?, completed_at=? WHERE id=?")
      .run(status, errorCode, new Date().toISOString(), current.id);
    return this.getTurn(current.id);
  }

  appendEvent(sessionId: string, turnId: string | null, method: string, payload: unknown): CodexEvent {
    const current = this.getSession(sessionId);
    if (turnId !== null && this.getTurn(turnId).sessionId !== current.id) {
      throw new CodexStoreError("TURN_OUT_OF_SESSION", "This turn does not belong to the session.");
    }
    if (!/^[a-zA-Z][a-zA-Z0-9/._-]{0,120}$/.test(method)) throw new CodexStoreError("INVALID_EVENT", "Invalid event method.");
    const json = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(json, "utf8") > 512 * 1024) throw new CodexStoreError("EVENT_TOO_LARGE", "Codex event is too large.");
    const result = this.connection.prepare("INSERT INTO codex_events(session_id,turn_id,method,payload_json,created_at) VALUES (?,?,?,?,?)")
      .run(current.id, turnId, method, json, new Date().toISOString());
    return this.listEvents(current.id, Number(result.lastInsertRowid) - 1, 1)[0];
  }

  listEvents(sessionId: string, afterSeq = 0, limit = 100): CodexEvent[] {
    const current = this.getSession(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new CodexStoreError("INVALID_PAGE", "Invalid event page.");
    }
    const rows = this.connection.prepare("SELECT * FROM codex_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(current.id, afterSeq, limit) as Array<{ seq: number; session_id: string; turn_id: string | null; method: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ seq: row.seq, sessionId: row.session_id, turnId: row.turn_id, method: row.method,
      payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at }));
  }

  listRecentEvents(sessionId: string, limit = 200): CodexEvent[] {
    const current = this.getSession(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new CodexStoreError("INVALID_PAGE", "Invalid event page.");
    const rows = this.connection.prepare("SELECT * FROM codex_events WHERE session_id=? ORDER BY seq DESC LIMIT ?")
      .all(current.id, limit) as Array<{ seq: number; session_id: string; turn_id: string | null; method: string; payload_json: string; created_at: string }>;
    return rows.reverse().map((row) => ({ seq: row.seq, sessionId: row.session_id, turnId: row.turn_id, method: row.method,
      payload: JSON.parse(row.payload_json) as unknown, createdAt: row.created_at }));
  }
}
