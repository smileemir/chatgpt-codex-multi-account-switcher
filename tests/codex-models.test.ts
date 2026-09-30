import assert from "node:assert/strict";
import test from "node:test";
import { listCodexModels } from "../apps/native-host/src/codex/models.ts";

test("model catalog is account-scoped, ordered, and only displays visible model slugs", async () => {
  const requested: string[] = [];
  const models = await listCodexModels({ getAccessToken: async (id) => `token-${id}` }, "account-a", async (_url, init) => {
    requested.push(String((init?.headers as Record<string, string>).authorization));
    return new Response(JSON.stringify({ models: [
      { slug: "gpt-one", display_name: "GPT One", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      { slug: "gpt-two", display_name: "GPT Two", visibility: "list" },
      { slug: "gpt-one", display_name: "Duplicate", visibility: "list" },
    ] }), { status: 200 });
  });
  assert.deepEqual(requested, ["Bearer token-account-a"]);
  assert.deepEqual(models, [{ slug: "gpt-one", displayName: "GPT One" }, { slug: "gpt-two", displayName: "GPT Two" }]);
});
