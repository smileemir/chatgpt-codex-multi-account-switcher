import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."); const extensionSource = path.join(root, "apps/extension"); const extensionOutput = path.join(root, "dist/extension"); const nativeOutput = path.join(root, "dist/native");
await rm(path.join(root, "dist"), { recursive: true, force: true }); await mkdir(extensionOutput, { recursive: true }); await mkdir(nativeOutput, { recursive: true });
async function copyStatic(from, to) { for (const entry of await readdir(from, { withFileTypes: true })) { const source = path.join(from, entry.name); const target = path.join(to, entry.name); if (entry.isDirectory()) { await mkdir(target, { recursive: true }); await copyStatic(source, target); } else if (entry.isFile() && !/\.(tsx?|jsx?)$/.test(entry.name)) await cp(source, target); } }
await copyStatic(extensionSource, extensionOutput);
await build({ entryPoints: [path.join(extensionSource, "dashboard/main.tsx"), path.join(extensionSource, "background/index.ts")], outbase: extensionSource, outdir: extensionOutput, entryNames: "[dir]/[name]", bundle: true, platform: "browser", format: "iife", target: ["chrome120"], minify: true, legalComments: "none" });
await build({ entryPoints: [path.join(root, "apps/native-host/src/bridge.ts"), path.join(root, "apps/native-host/src/service.ts")], outdir: nativeOutput, entryNames: "[name]", bundle: true, platform: "node", format: "cjs", target: ["node22"], minify: false, legalComments: "none" });
await cp(path.join(root, "package.json"), path.join(nativeOutput, "package.json"));
const nativePackage = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(nativeOutput, "package.json"), "utf8"));
nativePackage.type = "commonjs";
await (await import("node:fs/promises")).writeFile(path.join(nativeOutput, "package.json"), JSON.stringify(nativePackage, null, 2));
console.log("Built dist/extension and dist/native");
