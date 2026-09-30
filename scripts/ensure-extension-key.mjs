import { generateKeyPairSync, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const filename = path.resolve(import.meta.dirname, "../apps/extension/manifest.json");
const manifest = JSON.parse(await readFile(filename, "utf8"));
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  manifest.key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
}
const bytes = Buffer.from(manifest.key, "base64");
const id = [...createHash("sha256").update(bytes).digest().subarray(0, 16)]
  .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
  .join("");
console.log(`Unpacked extension ID: ${id}`);
