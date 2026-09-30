import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function dataRoot(): string {
  return process.env.CODEX_SWITCHER_DATA_ROOT
    ? path.resolve(process.env.CODEX_SWITCHER_DATA_ROOT)
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ChatGPTCodexMultiAccountSwitcher")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "ChatGPTCodexMultiAccountSwitcher")
        : path.join(os.homedir(), ".local", "share", "ChatGPTCodexMultiAccountSwitcher");
}

export function serviceSocketPath(): string {
  if (process.platform === "win32") {
    const suffix = createHash("sha256").update(dataRoot().toLowerCase()).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\chatgpt-codex-switcher-${suffix}`;
  }
  return path.join(dataRoot(), "run", "service.sock");
}

export function installConfigPath(): string { return path.join(dataRoot(), "config", "install.json"); }
