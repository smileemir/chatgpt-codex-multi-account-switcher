import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

export interface OpenAiIdentity {
  issuer: string;
  subject: string;
  email: string | null;
}

type JsonObject = Record<string, unknown>;
const ISSUER = "https://auth.openai.com";
const JWKS = `${ISSUER}/.well-known/jwks.json`;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODEX_AUTH_INVALID_ID_TOKEN");
  return value as JsonObject;
}

function decode(part: string): JsonObject {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || part.length > 16_384) throw new Error("CODEX_AUTH_INVALID_ID_TOKEN");
  return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
}

/** Verify OpenAI identity before any account association or credential write. */
export async function verifyOpenAiIdToken(
  token: string,
  expectedClientId: string,
  expectedNonce: string,
  http: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<OpenAiIdentity> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 32_768) throw new Error("invalid JWT");
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.typ && header.typ !== "JWT") {
      throw new Error("unsupported JWT header");
    }
    const response = await http(JWKS, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("JWKS unavailable");
    const raw = await response.text();
    if (raw.length > 128 * 1024) throw new Error("JWKS too large");
    const keys = object(JSON.parse(raw)).keys;
    if (!Array.isArray(keys)) throw new Error("invalid JWKS");
    const jwk = keys.map(object).find((key) => key.kid === header.kid && key.kty === "RSA" &&
      (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"));
    if (!jwk) throw new Error("unknown signing key");
    const valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }), Buffer.from(parts[2], "base64url"));
    if (!valid) throw new Error("invalid signature");
    const seconds = now / 1000;
    if (claims.iss !== ISSUER || claims.aud !== expectedClientId || claims.nonce !== expectedNonce ||
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.exp !== "number" || claims.exp <= seconds - 5 ||
      typeof claims.iat !== "number" || claims.iat > seconds + 5 ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + 5))) {
      throw new Error("invalid identity claims");
    }
    return { issuer: ISSUER, subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    // Never include a token or remote response in errors or logs.
    throw new Error("CODEX_AUTH_INVALID_ID_TOKEN");
  }
}
