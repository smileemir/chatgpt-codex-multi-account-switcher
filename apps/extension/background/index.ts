import { HOST_NAME, PROTOCOL_VERSION, type CommandRequest, type CommandResponse } from "../../../packages/contracts/src/index";
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null || !("kind" in message) || message.kind !== "codex.native" || !("request" in message)) return false;
  const request = message.request as CommandRequest;
  if (!request || request.v !== PROTOCOL_VERSION || typeof request.requestId !== "string" || typeof request.type !== "string") return false;
  void chrome.runtime.sendNativeMessage(HOST_NAME, request).then((value: CommandResponse | undefined) => sendResponse(value ?? { v: PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: { code: "HOST_UNAVAILABLE", message: "Host unavailable" } } satisfies CommandResponse)).catch(() => sendResponse({ v: PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: { code: "HOST_UNAVAILABLE", message: "Host unavailable" } } satisfies CommandResponse));
  return true;
});
