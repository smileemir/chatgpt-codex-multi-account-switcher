const readline = require("node:readline");

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === "turn/start") {
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } } });
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
  } else if (message.method === "test/approval") {
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "test" } });
    send({ id: message.id, result: {} });
  } else if (message.method === "test/unsupported") {
    send({ id: "unsupported-1", method: "item/tool/call", params: { name: "untrusted" } });
    send({ id: message.id, result: {} });
  } else if (message.id === "approval-1") {
    send({ method: "test/approvalResolved", params: { decision: message.result.decision } });
  } else if (message.id === "unsupported-1") {
    send({ method: "test/unsupportedResolved", params: { code: message.error.code } });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
