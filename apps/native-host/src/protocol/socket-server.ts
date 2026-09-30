import { lstat, mkdir, chmod, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { timingSafeEqual } from "node:crypto";
import { PROTOCOL_VERSION, type CommandRequest, type CommandResponse } from "../../../../packages/contracts/src/index.ts";
import { ProtocolError, validateRequest } from "./validate.ts";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 950 * 1024;

const publicMessages: Record<string, string> = {
  BAD_REQUEST: "The request is invalid.",
  PROTOCOL_VERSION: "The extension and helper versions differ.",
  UNKNOWN_COMMAND: "This action is not supported.",
  CODEX_CLI_NOT_FOUND: "Install the Codex CLI to start a coding session.",
  CODEX_AUTH_RECONNECT_REQUIRED: "Reconnect this ChatGPT account.",
  ACCOUNT_NOT_CONNECTED: "Connect every selected ChatGPT account first.",
  ACCOUNT_OUT_OF_POOL: "This account is not in the session pool.",
  INVALID_WORKSPACE: "Choose an absolute workspace directory owned by you.",
  TURN_ACTIVE: "Wait for the current coding turn to finish.",
  USAGE_LIMIT: "This account reached its usage limit; switch to another account or wait for reset.",
  NETWORK_ERROR: "A network error occurred. Try again.",
};

function safeError(requestId: string, error: unknown): CommandResponse {
  const code =
    error instanceof ProtocolError
      ? error.code
      : typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof Error && /^(CODEX_AUTH|CODEX_MODEL)_[A-Z_]+$/.test(error.message)
          ? error.message
        : "INTERNAL_ERROR";
  return {
    v: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message: publicMessages[code] ?? "The action could not be completed. Check Diagnostics." },
  };
}

export type Dispatcher = (request: CommandRequest) => Promise<unknown>;

export async function startSocketServer(socketPath: string, dispatch: Dispatcher, options: { serviceSecret?: string } = {}): Promise<net.Server> {
  const isWindowsPipe = socketPath.startsWith("\\\\.\\pipe\\");
  if (isWindowsPipe && !/^[0-9a-f]{64}$/i.test(options.serviceSecret || "")) throw new Error("Windows pipe requires an installation secret");
  if (!isWindowsPipe) {
    const directory = path.dirname(socketPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dirStatus = await lstat(directory);
    if (!dirStatus.isDirectory() || dirStatus.isSymbolicLink()) throw new Error("Unsafe service socket directory");
    await chmod(directory, 0o700);

    try {
      const status = await lstat(socketPath);
      const uid = process.getuid?.();
      if (uid === undefined || !status.isSocket() || status.uid !== uid) throw new Error("Unsafe existing service socket");
      await new Promise<void>((resolve, reject) => {
        const client = net.createConnection(socketPath);
        client.once("connect", () => {
          client.destroy();
          reject(new Error("The service is already running"));
        });
        client.once("error", () => resolve());
      });
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const server = net.createServer((socket) => {
    socket.setTimeout(50_000);
    const decoder = new StringDecoder("utf8");
    let data = "";
    let handled = false;
    socket.on("timeout", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      data += decoder.write(chunk);
      if (Buffer.byteLength(data, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify(safeError("", new ProtocolError("BAD_REQUEST", "Oversized request")))}\n`);
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let requestId = "";
      void (async () => {
        let result: CommandResponse;
        try {
          const raw = JSON.parse(data.slice(0, newline)) as unknown;
          if (typeof raw === "object" && raw !== null && "requestId" in raw && typeof raw.requestId === "string") {
            requestId = raw.requestId;
          }
          let requestInput: unknown = raw;
          if (options.serviceSecret) {
            const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
            const received = typeof envelope.serviceSecret === "string" ? envelope.serviceSecret : "";
            const expected = options.serviceSecret;
            const valid = /^[0-9a-f]{64}$/i.test(received) && timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
            if (!valid) throw new ProtocolError("ORIGIN_FORBIDDEN", "Invalid service authorization");
            requestInput = envelope.request;
          }
          const request = validateRequest(requestInput);
          const response = await dispatch(request);
          result = { v: PROTOCOL_VERSION, requestId: request.requestId, ok: true, data: response };
        } catch (error) {
          result = safeError(requestId, error);
        }
        let output = JSON.stringify(result);
        if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) {
          output = JSON.stringify(safeError(requestId, new ProtocolError("RESPONSE_TOO_LARGE", "Oversized response")));
        }
        socket.end(`${output}\n`);
      })();
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isWindowsPipe) {
    await chmod(socketPath, 0o600);
    server.on("close", () => {
      void unlink(socketPath).catch(() => undefined);
    });
  }
  return server;
}

export async function sendSocketRequest(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const decoder = new StringDecoder("utf8");
    let data = "";
    client.setTimeout(5_000);
    client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      data += decoder.write(chunk);
      if (data.includes("\n")) {
        client.end();
        try {
          resolve(JSON.parse(data.slice(0, data.indexOf("\n"))));
        } catch (error) {
          reject(error);
        }
      }
    });
    client.on("timeout", () => client.destroy(new Error("Socket timed out")));
    client.on("error", reject);
  });
}
