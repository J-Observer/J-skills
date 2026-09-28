// 用途：Worker 内验证 checkout-return JWT、webhook Ed25519 签名，并通过 Merchant API 复核订单。
// 参数：调用方提供环境、JWKS URL、订单号、API key 和原始请求体；登录态：无浏览器登录。
// 已知坑：签名使用原始 body；订单 API 返回平铺 productId。验证日期：2026-09-07（原流程）。

export type AnywayEnvName = "stg" | "prod";

export const ANYWAY_ENVIRONMENTS: Record<AnywayEnvName, { apiBase: string; jwksUrl: string }> = {
  prod: {
    apiBase: "https://merchant-api-prod.anyway.sh",
    jwksUrl: "https://api.anyway.sh/v1/webhooks/signing-key"
  },
  stg: {
    apiBase: "https://merchant-api-stg.anyway.sh",
    jwksUrl: "https://webapp-api-stg.anyway.sh/v1/webhooks/signing-key"
  }
};

/// 未指定时默认 stg；项目需明确传入生产环境。
export function resolveAnywayEnv(value: string | undefined): AnywayEnvName {
  return value === "prod" ? "prod" : "stg";
}

// --- Webhook signature verification ----------------------------------------

export type ParsedSignature = { version: string; signature: string };

/// Parse a `webhook-signature` header value, which may contain multiple
/// space-separated `<version>,<base64 signature>` candidates (at-least-once
/// delivery / key-rotation overlap can produce more than one). Malformed
/// candidates (no comma, empty signature) are dropped rather than throwing.
export function parseSignatureHeader(header: string): ParsedSignature[] {
  return header
    .trim()
    .split(/\s+/)
    .filter((candidate) => candidate.length > 0)
    .map((candidate): ParsedSignature | null => {
      const commaIndex = candidate.indexOf(",");
      if (commaIndex === -1) return null;
      const version = candidate.slice(0, commaIndex);
      const signature = candidate.slice(commaIndex + 1);
      return signature.length > 0 ? { version, signature } : null;
    })
    .filter((value): value is ParsedSignature => value !== null);
}

type JWKSDocument = { keys?: JsonWebKey[] };

// Per-isolate in-memory JWKS cache, keyed by jwksUrl (stg and prod never
// collide). A Worker isolate is short-lived, so this is a soft cache — its
// only job is to avoid a JWKS fetch on every webhook delivery within one
// isolate's lifetime, with a forced refetch-and-retry on verification
// failure to tolerate key rotation.
const jwksKeyCache = new Map<string, CryptoKey[]>();

export function clearAnywayJwksCache(): void {
  jwksKeyCache.clear();
}

async function fetchAndImportKeys(jwksUrl: string, fetchImpl: typeof fetch): Promise<CryptoKey[]> {
  const response = await fetchImpl(jwksUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Failed to fetch Anyway signing key from ${jwksUrl}: HTTP ${response.status}`);
  }
  const doc = (await response.json()) as JWKSDocument;
  const keys: CryptoKey[] = [];
  for (const jwk of doc.keys ?? []) {
    try {
      keys.push(await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]));
    } catch {
      // skip malformed/unsupported JWK entries
    }
  }
  jwksKeyCache.set(jwksUrl, keys);
  return keys;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function verifyAgainstKeys(
  id: string,
  timestamp: string,
  signatureHeader: string,
  rawBody: string | Uint8Array,
  keys: CryptoKey[]
): Promise<boolean> {
  if (keys.length === 0) return false;
  const encoder = new TextEncoder();
  const bodyBytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signedContent = new Uint8Array(prefix.length + bodyBytes.length);
  signedContent.set(prefix, 0);
  signedContent.set(bodyBytes, prefix.length);

  for (const candidate of parseSignatureHeader(signatureHeader)) {
    if (candidate.version !== "v1a") continue;
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = base64ToBytes(candidate.signature);
    } catch {
      continue;
    }
    for (const key of keys) {
      try {
        if (await crypto.subtle.verify("Ed25519", key, signatureBytes, signedContent)) return true;
      } catch {
        // try next key
      }
    }
  }
  return false;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/// Verify a `webhook-id` / `webhook-timestamp` / `webhook-signature` triple
/// against Anyway's published JWKS. Caches imported keys per `jwksUrl` for
/// the isolate's lifetime; on a verification failure it refetches once
/// (bypassing the cache) and retries, to tolerate key rotation, before giving
/// up — mirrors the CLI's cache-then-retry-once behavior
/// (scripts/anyway/anyway.mjs `webhook verify`).
export async function verifyAnywayWebhook(params: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string | Uint8Array;
  jwksUrl: string;
  fetch?: typeof fetch;
  now?: number;
  maxSkewSeconds?: number;
}): Promise<VerifyResult> {
  const { id, timestamp, signature, rawBody, jwksUrl } = params;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing webhook-id / webhook-timestamp / webhook-signature header" };
  }

  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) {
    return { ok: false, reason: "webhook-timestamp is not a valid integer" };
  }
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const maxSkewSeconds = params.maxSkewSeconds ?? 300;
  if (Math.abs(now - ts) > maxSkewSeconds) {
    return { ok: false, reason: `stale webhook timestamp (|now-ts| > ${maxSkewSeconds}s)` };
  }

  const fetchImpl = params.fetch ?? fetch;
  let keys = jwksKeyCache.get(jwksUrl);
  if (!keys) {
    keys = await fetchAndImportKeys(jwksUrl, fetchImpl);
  }

  if (await verifyAgainstKeys(id, timestamp, signature, rawBody, keys)) return { ok: true };

  // Refresh once and retry — tolerates key rotation between deliveries.
  keys = await fetchAndImportKeys(jwksUrl, fetchImpl);
  if (await verifyAgainstKeys(id, timestamp, signature, rawBody, keys)) return { ok: true };

  return { ok: false, reason: "no matching valid v1a signature found" };
}

// --- Checkout-return callback JWT verification --------------------------
//
// Anyway appends a signed JWT (`sig`) to the checkout-return redirect URL —
// `{aud, iss:"anyway", status, sub:<orderId>, iat, exp}`, EdDSA-signed with
// the same per-environment Ed25519 JWKS as webhook delivery (see
// `verifyAnywayWebhook` above). This lets `调用方的订单领取流程`
// prove the caller actually completed checkout for that order (rather than
// just knowing/guessing the orderId from a URL) without needing a webhook
// round-trip to have landed first.
//
// Deliberately independent of the Standard Webhooks verification above (that
// signs `id.timestamp.body` over an arbitrary raw body with a
// space-separated multi-candidate header); this is a plain compact JWT
// (`base64url(header).base64url(payload).base64url(signature)`, alg
// "EdDSA") signed over its own header+payload — different wire format, same
// key material.

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padLength = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return base64ToBytes(padded + "=".repeat(padLength));
}

function decodeJwtJsonSegment(segment: string): unknown {
  const bytes = base64UrlToBytes(segment);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type AnywayCallbackClaims = {
  aud: string;
  iss: string;
  status: string;
  sub: string;
  iat: number;
  exp: number;
};

export type VerifyCallbackResult =
  | { ok: true; claims: AnywayCallbackClaims }
  | { ok: false; reason: string };

/// Verify Anyway's checkout-return `sig` JWT. Checks (in order): well-formed
/// compact JWT, `alg === "EdDSA"`, a valid Ed25519 signature against the
/// env's JWKS (cache-then-refetch-once, same as `verifyAnywayWebhook`), then
/// claims: `iss === "anyway"`, `sub === expectedOrderId`, `status === "paid"`,
/// `exp` not in the past, and `aud` present in `allowedAudiences`. Signature
/// is checked before claims are trusted for anything (an unsigned/forged
/// token must never influence the reason string in a way that leaks which
/// check "would have" failed next).
export async function verifyAnywayCallbackJwt(params: {
  jwt: string | null | undefined;
  jwksUrl: string;
  expectedOrderId: string;
  allowedAudiences: string[];
  now?: number;
  fetch?: typeof fetch;
}): Promise<VerifyCallbackResult> {
  const { jwt, jwksUrl, expectedOrderId, allowedAudiences } = params;
  if (!jwt) return { ok: false, reason: "missing sig" };

  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: unknown;
  let claims: unknown;
  try {
    header = decodeJwtJsonSegment(headerB64);
    claims = decodeJwtJsonSegment(payloadB64);
  } catch {
    return { ok: false, reason: "malformed JWT segment" };
  }

  const alg = asRecord(header)?.alg;
  if (alg !== "EdDSA") return { ok: false, reason: `unsupported alg: ${String(alg)}` };

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(signatureB64);
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  const signedContent = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const verifyAgainst = async (keys: CryptoKey[]): Promise<boolean> => {
    for (const key of keys) {
      try {
        if (await crypto.subtle.verify("Ed25519", key, signatureBytes, signedContent)) return true;
      } catch {
        // try next key
      }
    }
    return false;
  };

  const fetchImpl = params.fetch ?? fetch;
  let keys = jwksKeyCache.get(jwksUrl);
  if (!keys) keys = await fetchAndImportKeys(jwksUrl, fetchImpl);
  let signatureOK = await verifyAgainst(keys);
  if (!signatureOK) {
    // Refresh once and retry — tolerates key rotation, same as the webhook path.
    keys = await fetchAndImportKeys(jwksUrl, fetchImpl);
    signatureOK = await verifyAgainst(keys);
  }
  if (!signatureOK) return { ok: false, reason: "signature verification failed" };

  const record = asRecord(claims);
  if (!record) return { ok: false, reason: "payload is not an object" };
  if (record.iss !== "anyway") return { ok: false, reason: "iss mismatch" };
  if (record.sub !== expectedOrderId) return { ok: false, reason: "sub mismatch" };
  if (record.status !== "paid") return { ok: false, reason: "status is not paid" };
  if (typeof record.aud !== "string" || !allowedAudiences.includes(record.aud)) {
    return { ok: false, reason: "aud not allowed" };
  }
  const exp = typeof record.exp === "number" ? record.exp : null;
  if (exp === null) return { ok: false, reason: "missing exp" };
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (now > exp) return { ok: false, reason: "expired" };

  return { ok: true, claims: record as unknown as AnywayCallbackClaims };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>) : undefined;
}

export type AnywayOrderApiResult = {
  status: string;
  amountCents: number;
  currency: string;
  merchantReference: string | null;
  merchantMetadata: Record<string, unknown> | null;
  productId: string;
};

export class AnywayApiError extends Error {}

/// GET /v1/orders/{id} against the Merchant API, used to re-check a webhook
/// delivery's claims (status/amount/currency/product) before trusting them —
/// the webhook signature proves the request came from Anyway, not that the
/// payload wasn't stale or truncated. Auth: header `X-API-Key`.
export async function fetchAnywayOrder(params: {
  orderId: string;
  apiBase: string;
  apiKey: string;
  fetch?: typeof fetch;
}): Promise<AnywayOrderApiResult> {
  const fetchImpl = params.fetch ?? fetch;
  const response = await fetchImpl(`${params.apiBase}/v1/orders/${encodeURIComponent(params.orderId)}`, {
    headers: { "X-API-Key": params.apiKey, Accept: "application/json" }
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new AnywayApiError(`Anyway order fetch failed: HTTP ${response.status}`);
  }
  const body = json as { success?: boolean; data?: AnywayOrderApiResult } | null;
  if (!body || body.success === false || !body.data) {
    throw new AnywayApiError("Anyway order fetch returned no data");
  }
  return body.data;
}
