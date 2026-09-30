import type { CodexAuthManager } from "./auth.ts";

export interface CodexModel { slug: string; displayName: string }

export async function listCodexModels(auth: Pick<CodexAuthManager, "getAccessToken">, accountId: string, http: typeof fetch = fetch): Promise<CodexModel[]> {
  const token = await auth.getAccessToken(accountId);
  let response: Response;
  try {
    response = await http("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("CODEX_MODEL_NETWORK_ERROR"); }
  if (!response.ok) throw new Error(response.status === 401 ? "CODEX_AUTH_RECONNECT_REQUIRED" : "CODEX_MODEL_LIST_FAILED");
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error("CODEX_MODEL_RESPONSE_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("CODEX_MODEL_RESPONSE_INVALID"); }
  const rows = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) throw new Error("CODEX_MODEL_RESPONSE_INVALID");
  const models: CodexModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (item.visibility !== "list" || typeof item.slug !== "string" || !/^[a-zA-Z0-9._-]{1,120}$/.test(item.slug) || seen.has(item.slug)) continue;
    seen.add(item.slug);
    models.push({ slug: item.slug, displayName: typeof item.display_name === "string" && item.display_name.length <= 120 ? item.display_name : item.slug });
    if (models.length >= 200) break;
  }
  return models;
}
