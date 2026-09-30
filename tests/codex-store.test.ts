import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareCodexRoot } from "./fixtures/codex-root.ts";
import { CodexSessionStore } from "../apps/native-host/src/codex/store.ts";

test("Codex sessions survive restart and recover unfinished turns without losing events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-store-"));
  await prepareCodexRoot(root);
  const first = new CodexSessionStore(root);
  const accountA = randomUUID();
  const accountB = randomUUID();
  try {
    await first.initialize();
    const created = first.createSession({
      title: "Continuity test", cwd: root, model: "test-model",
      activeAccountId: accountA, accountOrder: [accountA, accountB], autoSwitch: true,
    });
    first.updateSession(created.id, { threadId: randomUUID(), status: "running" });
    const turn = first.createTurn(created.id, accountA, "Remember this decision.");
    first.markTurnRunning(turn.id, accountA, randomUUID());
    first.appendAssistantText(turn.id, "Decision saved.");
    const event = first.appendEvent(created.id, turn.id, "item/agentMessage/delta", { delta: "Decision saved." });
    assert.equal(first.listEvents(created.id, 0)[0].seq, event.seq);
    first.close();

    const reopened = new CodexSessionStore(root);
    await reopened.initialize();
    assert.equal(reopened.getSession(created.id).status, "paused");
    assert.equal(reopened.getTurn(turn.id).status, "interrupted");
    assert.equal(reopened.getTurn(turn.id).assistantText, "Decision saved.");
    assert.equal(reopened.listEvents(created.id, event.seq - 1)[0].method, "item/agentMessage/delta");
    assert.throws(() => reopened.updateSession(created.id, { activeAccountId: randomUUID() }), { code: "ACCOUNT_OUT_OF_POOL" });
    const other = reopened.createSession({ title: "Other", cwd: root, model: "test-model", activeAccountId: accountB, accountOrder: [accountB], autoSwitch: false });
    assert.throws(() => reopened.appendEvent(other.id, turn.id, "test/event", {}), { code: "TURN_OUT_OF_SESSION" });
    reopened.close();
  } finally {
    first.close();
    await rm(root, { recursive: true, force: true });
  }
});
