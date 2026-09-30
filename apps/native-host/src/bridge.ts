import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { PROTOCOL_VERSION, type CommandResponse } from "../../../packages/contracts/src/index.ts";
import { installConfigPath, serviceSocketPath } from "./platform.ts";

const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 950 * 1024;
const BYTE_ORDER = os.endianness();

function response(requestId: string, code: string, message: string): CommandResponse {
  return {
    v: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  };
}

function writeNativeMessage(value: unknown): void {
  let json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.byteLength > OUTPUT_LIMIT) {
    json = Buffer.from(
      JSON.stringify(response("", "RESPONSE_TOO_LARGE", "The response exceeded the native messaging limit.")),
      "utf8",
    );
  }
  const header = Buffer.alloc(4);
  if (BYTE_ORDER === "LE") header.writeUInt32LE(json.byteLength, 0);
  else header.writeUInt32BE(json.byteLength, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function readNativeMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let expected: number | null = null;
    const timer = setTimeout(() => finish(new Error("Input timed out")), 15_000);
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.pause();
      if (error) reject(error);
      else resolve(value);
    }
    function onError(error: Error) {
      finish(error);
    }
    function onData(chunk: Buffer) {
      bytes = Buffer.concat([bytes, chunk]);
      if (expected === null && bytes.byteLength >= 4) {
        expected = BYTE_ORDER === "LE" ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
        if (expected < 2 || expected > INPUT_LIMIT) {
          finish(new Error("Invalid native message length"));
          return;
        }
      }
      if (expected !== null && bytes.byteLength >= expected + 4) {
        try {
          finish(undefined, JSON.parse(bytes.subarray(4, expected + 4).toString("utf8")));
        } catch {
          finish(new Error("Invalid native message JSON"));
        }
      }
    }
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

async function verifyOrigin(): Promise<string | undefined> {
  const origin = process.argv[2];
  const config = JSON.parse(await readFile(installConfigPath(), "utf8")) as { extensionId?: unknown; serviceSecret?: unknown };
  if (typeof config.extensionId !== "string" || !/^[a-p]{32}$/.test(config.extensionId)) {
    throw new Error("Invalid install configuration");
  }
  const expectedOrigin = `chrome-extension://${config.extensionId}`;
  if (origin !== expectedOrigin && origin !== `${expectedOrigin}/`) {
    throw new Error("Unrecognized extension origin");
  }
  if (process.platform === "win32") {
    if (typeof config.serviceSecret !== "string" || !/^[0-9a-f]{64}$/i.test(config.serviceSecret)) throw new Error("Invalid service authorization");
    return config.serviceSecret;
  }
}

function callService(request: unknown, serviceSecret?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(serviceSocketPath());
    const decoder = new StringDecoder("utf8");
    let received = "";
    socket.setTimeout(45_000);
    socket.on("connect", () => socket.write(`${JSON.stringify(serviceSecret ? { serviceSecret, request } : request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      received += decoder.write(chunk);
      if (received.length > OUTPUT_LIMIT) {
        socket.destroy();
        reject(new Error("Service response too large"));
        return;
      }
      const newline = received.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        try {
          resolve(JSON.parse(received.slice(0, newline)));
        } catch {
          reject(new Error("Invalid service response"));
        }
      }
    });
    socket.on("timeout", () => socket.destroy(new Error("Service timed out")));
    socket.on("error", reject);
    socket.on("end", () => {
      if (!received.includes("\n")) reject(new Error("Service closed without a response"));
    });
  });
}

async function main(): Promise<void> {
  let requestId = "";
  try {
    const request = await readNativeMessage();
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("Invalid request");
    }
    const object = request as Record<string, unknown>;
    requestId = typeof object.requestId === "string" ? object.requestId : "";
    const serviceSecret = await verifyOrigin();
    const result = await callService(request, serviceSecret);
    writeNativeMessage(result);
  } catch (error) {
    const code = error instanceof Error && error.message.includes("origin") ? "ORIGIN_FORBIDDEN" : "SERVICE_UNAVAILABLE";
    console.error(error instanceof Error ? error.message : "Bridge failure");
    writeNativeMessage(response(requestId, code, "The local helper is unavailable. Open Settings for repair steps."));
  }
}

void main();
