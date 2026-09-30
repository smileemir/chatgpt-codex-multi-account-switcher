import { execFile } from "node:child_process";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createDispatcher } from "./dispatcher.ts";
import { createCodexAuthManager } from "./codex/auth.ts";
import { CodexContinuityManager } from "./codex/continuity.ts";
import { CodexSessionStore } from "./codex/store.ts";
import { dataRoot, installConfigPath, serviceSocketPath } from "./platform.ts";
import { startSocketServer } from "./protocol/socket-server.ts";

process.umask(0o077);
async function windowsServiceSecret(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const info = await lstat(installConfigPath());
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("UNSAFE_INSTALL_CONFIG");
  const config = JSON.parse(await readFile(installConfigPath(), "utf8")) as { serviceSecret?: unknown };
  if (typeof config.serviceSecret !== "string" || !/^[a-f0-9]{64}$/i.test(config.serviceSecret)) throw new Error("INVALID_SERVICE_SECRET");
  return config.serviceSecret;
}
async function main(): Promise<void> {
  const root = dataRoot();
  await mkdir(path.join(root, "database"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "config"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "codex", "home"), { recursive: true, mode: 0o700 });
  const dbHandle = await open(path.join(root, "database", "app.sqlite"), "a"); await dbHandle.close();
  const store = new CodexSessionStore(root); await store.initialize();
  const auth = createCodexAuthManager({ dataRoot: root, appName: "chatgpt_codex_multi_account_switcher", openAuthorizationUrl: async (url) => {
    if (process.platform === "win32") { const systemRoot = process.env.SystemRoot ?? "C:\\Windows"; await promisify(execFile)(path.win32.join(systemRoot, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url], { timeout: 5_000 }); }
    else await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open", [url], { timeout: 5_000 });
  } });
  const candidates = process.platform === "darwin"
    ? [process.env.CODEX_SWITCHER_CODEX_EXECUTABLE, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
    : process.platform === "win32"
      ? [process.env.CODEX_SWITCHER_CODEX_EXECUTABLE, path.join(process.env.LOCALAPPDATA ?? "", "Programs", "codex", "codex.exe")]
      : [process.env.CODEX_SWITCHER_CODEX_EXECUTABLE, "/usr/local/bin/codex", "/usr/bin/codex"];
  let executable = ""; for (const candidate of candidates) { if (!candidate || !path.isAbsolute(candidate)) continue; try { await access(candidate); executable = candidate; break; } catch { /* next candidate */ } }
  const continuity = new CodexContinuityManager({ store, accounts: auth, codexExecutable: executable, codexHome: path.join(root, "codex", "home") });
  const server = await startSocketServer(serviceSocketPath(), createDispatcher({ auth, store, continuity }), { serviceSecret: await windowsServiceSecret() });
  let closing = false;
  async function shutdown() { if (closing) return; closing = true; auth.dispose(); await continuity.close(); store.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  process.on("SIGTERM", () => { void shutdown(); }); process.on("SIGINT", () => { void shutdown(); });
}
void main().catch((error: unknown) => { const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "STARTUP_FAILED"; console.error(`ChatGPT Codex Multi Account Switcher service could not start: ${code}`); process.exitCode = 1; });
