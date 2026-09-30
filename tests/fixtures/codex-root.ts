import { mkdir, open } from "node:fs/promises";
import path from "node:path";
export async function prepareCodexRoot(root: string): Promise<void> {
  await mkdir(path.join(root, "database"), { recursive: true });
  const handle = await open(path.join(root, "database", "app.sqlite"), "a");
  await handle.close();
}
