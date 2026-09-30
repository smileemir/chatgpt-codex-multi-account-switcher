import { randomUUID } from "node:crypto";
import { open, readFile, rename, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CodexCredential {
  id: string;
  label: string;
  issuer: string;
  subject: string;
  email: string | null;
  clientId: string;
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  scopes: string[];
  expiresAt: number;
}

export interface CodexPendingRegistration {
  id: string;
  clientId: string;
  createdAt: number;
}

interface StoreData { version: 1; hostId: string; accounts: CodexCredential[]; pendingRegistrations: CodexPendingRegistration[] }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CodexCredentialStore {
  private readonly file: string;
  private readonly lock: string;
  constructor(dataRoot: string) {
    this.file = join(dataRoot, "codex", "credentials.json");
    this.lock = join(dataRoot, "codex", "credentials.lock");
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
      throw new Error("CODEX_AUTH_UNSAFE_DIRECTORY");
    }
  }

  private async read(): Promise<StoreData | null> {
    await this.ensureDirectory();
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
        throw new Error("CODEX_AUTH_UNSAFE_FILE");
      }
      let value: unknown;
      try { value = JSON.parse(await readFile(this.file, "utf8")); }
      catch { throw new Error("CODEX_AUTH_INVALID_STORE"); }
      if (!value || typeof value !== "object" || (value as StoreData).version !== 1 ||
        typeof (value as StoreData).hostId !== "string" || !Array.isArray((value as StoreData).accounts) ||
        ((value as StoreData).pendingRegistrations !== undefined && !Array.isArray((value as StoreData).pendingRegistrations))) {
        throw new Error("CODEX_AUTH_INVALID_STORE");
      }
      return { ...(value as StoreData), pendingRegistrations: (value as StoreData).pendingRegistrations ?? [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(data: StoreData): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await this.ensureDirectory();
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const handle = await open(this.lock, "wx", 0o600);
        try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
        return async () => { await unlink(this.lock).catch(() => undefined); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await lstat(this.lock).catch(() => null);
        if (info && (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)) {
          throw new Error("CODEX_AUTH_UNSAFE_LOCK");
        }
        // A dead process can leave a lock. Never steal a live process's lock.
        if (info && Date.now() - info.mtimeMs > 60_000) {
          const pidText = await readFile(this.lock, "utf8").catch(() => "");
          const pid = Number(pidText);
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ESRCH") await unlink(this.lock).catch(() => undefined);
            }
          }
        }
        await pause(50);
      }
    }
    throw new Error("CODEX_AUTH_LOCK_TIMEOUT");
  }

  async transaction<T>(work: (data: StoreData) => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      const data = await this.read() ?? { version: 1 as const, hostId: `urn:uuid:${randomUUID()}`, accounts: [], pendingRegistrations: [] };
      const result = await work(data);
      await this.write(data);
      return result;
    } finally { await release(); }
  }

  async snapshot(): Promise<StoreData> {
    const data = await this.read();
    if (data) return data;
    await this.transaction(async () => undefined);
    return (await this.read())!;
  }
}
