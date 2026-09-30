import { HOST_NAME, PROTOCOL_VERSION, type CommandPayloads, type CommandRequest, type CommandResponse, type CommandType } from "../../../packages/contracts/src/index";
import { t } from "./i18n";
export { HOST_NAME };
export class NativeCommandError extends Error { constructor(readonly code: string) { super(code); this.name = "NativeCommandError"; } }
export async function command<K extends CommandType, T>(type: K, payload: CommandPayloads[K]): Promise<T> {
  const requestId = crypto.randomUUID(); const request: CommandRequest<K> = { v: PROTOCOL_VERSION, requestId, type, payload };
  let response: CommandResponse<T> | undefined; try { response = await chrome.runtime.sendMessage({ kind: "codex.native", request }); } catch { throw new NativeCommandError("HOST_UNAVAILABLE"); }
  if (!response) throw new NativeCommandError("HOST_UNAVAILABLE"); if (response.v !== PROTOCOL_VERSION || response.requestId !== requestId) throw new NativeCommandError("PROTOCOL_ERROR"); if (!response.ok) throw new NativeCommandError(response.error.code); return response.data;
}
const keys: Record<string, string> = { HOST_UNAVAILABLE: "errorHostUnavailable", SERVICE_UNAVAILABLE: "errorServiceUnavailable", DATABASE_NOT_READY: "errorServiceUnavailable", PROTOCOL_ERROR: "errorProtocol", CODEX_CLI_NOT_FOUND: "errorCodexCliMissing", CODEX_AUTH_RECONNECT_REQUIRED: "errorReauthRequired", CODEX_AUTH_DUPLICATE_IDENTITY: "errorCodexDuplicate", ACCOUNT_OUT_OF_POOL: "errorCodexAccountPool", INVALID_WORKSPACE: "errorCodexWorkspace", TURN_ACTIVE: "errorCodexBusy", CODEX_MODEL_LIST_FAILED: "errorCodexModel", CODEX_MODEL_NETWORK_ERROR: "errorNetwork", USAGE_LIMIT: "codexLimitNotice", RUNTIME_EXITED: "errorCodexRuntime", RUNTIME_RPC_ERROR: "errorCodexRuntime", RUNTIME_TIMEOUT: "errorCodexRuntime" };
export function errorMessage(error: unknown): string { return error instanceof NativeCommandError ? t(keys[error.code] ?? "errorGeneric") : t("errorGeneric"); }
export function errorCode(error: unknown): string | null { return error instanceof NativeCommandError ? error.code : null; }
