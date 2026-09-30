import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexRuntime } from "../apps/native-host/src/codex/runtime.ts";

test("Codex runtime resumes a thread and keeps early completion and approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-switcher-runtime-"));
  const fixture = path.resolve("tests/fixtures/fake-codex-server.cjs");
  const events: string[] = [];
  const eventDetails: Array<{ method: string; params: unknown }> = [];
  const childEnv: Array<NodeJS.ProcessEnv | undefined> = [];
  const runtime = new CodexRuntime({
    executable: process.execPath,
    codexHome: path.join(root, "codex-home"),
    accessToken: "fixture-token",
    onEvent: (event) => { events.push(event.method); eventDetails.push(event); },
    spawnProcess: ((_executable: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      childEnv.push(options?.env);
      return spawn(process.execPath, [fixture], { env: options?.env, stdio: ["pipe", "pipe", "pipe"] });
    }) as unknown as typeof spawn,
  });
  try {
    await runtime.start();
    assert.equal(await runtime.startThread({ cwd: root, model: "test-model" }), "thread-1");
    await runtime.resumeThread("thread-1", root, "test-model");
    const { completed } = await runtime.startTurn("thread-1", "hello");
    assert.equal((await completed).status, "completed");
    await runtime.request("test/approval", {});
    assert.ok(events.includes("approval/requested"));
    runtime.respondToApproval("approval-1", "decline");
    await runtime.request("test/unsupported", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.filter((method) => method === "approval/requested").length, 1);
    assert.ok(eventDetails.some((event) => event.method === "test/unsupportedResolved" &&
      (event.params as { code?: number }).code === -32601));
    assert.equal(childEnv[0]?.ACCESS_TOKEN, "fixture-token");
    assert.equal(childEnv[0]?.OPENAI_API_KEY, undefined);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
