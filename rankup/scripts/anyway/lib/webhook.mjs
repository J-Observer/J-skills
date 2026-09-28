// 用途：webhook JWKS 验签。参数：由上层 CLI 传入；登录态：无需浏览器登录。
// 已知坑：stg 与 prod 的 key 和 JWKS 地址独立。验证日期：2026-09-07（原流程）。
// Anyway webhook (Standard Webhooks, Ed25519 "v1a") verification.
//
// Pure WebCrypto implementation (crypto.subtle only, no Node `crypto` module)
// so this file can be copied as-is into a Cloudflare Worker.
//
// Signed message: `${id}.${timestamp}.${rawBody}`
// Header `webhook-signature` looks like: "v1a,<base64 sig>[ v1a,<base64 sig> ...]"
// Reject deliveries whose |now - timestamp| exceeds the allowed skew (default 300s).

export const SIGNING_KEY_URL = 'https://api.anyway.sh/v1/webhooks/signing-key';
export const DEFAULT_MAX_SKEW_SECONDS = 300;

/**
 * Fetch and parse the JWKS document Anyway publishes for webhook verification.
 * @param {typeof fetch} fetchImpl defaults to global fetch
 * @param {string} [jwksUrl] defaults to the prod signing-key URL; pass the
 *   per-environment URL (e.g. from lib/env.mjs) when verifying stg webhooks.
 * @returns {Promise<{keyId: string, algorithm: string, publicKey: string, keys: object[]}>}
 */
export async function fetchSigningKeys(fetchImpl = fetch, jwksUrl = SIGNING_KEY_URL) {
  const res = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch Anyway signing key from ${jwksUrl}: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Import every JWK in the JWKS document as a WebCrypto Ed25519 public key.
 * @param {{keys: object[]}} jwks
 * @returns {Promise<CryptoKey[]>}
 */
export async function importVerificationKeys(jwks) {
  const keys = jwks?.keys ?? [];
  const imported = [];
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'Ed25519' },
        false,
        ['verify']
      );
      imported.push(key);
    } catch {
      // skip malformed/unsupported JWK entries
    }
  }
  return imported;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Verify a `webhook-signature` header value against a set of candidate keys.
 * @param {object} params
 * @param {string} params.id `webhook-id` header value
 * @param {string} params.timestamp `webhook-timestamp` header value (unix seconds, as string)
 * @param {string} params.signatureHeader `webhook-signature` header value, possibly containing multiple space-separated `v1a,<sig>` entries
 * @param {Uint8Array|string} params.rawBody exact raw request body (bytes preferred; string is UTF-8 encoded)
 * @param {CryptoKey[]} params.keys imported Ed25519 public keys (see importVerificationKeys)
 * @param {number} [params.now] unix seconds "now" override, for testing
 * @param {number} [params.maxSkewSeconds] allowed |now - timestamp| skew, default 300
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyWebhookSignature({
  id,
  timestamp,
  signatureHeader,
  rawBody,
  keys,
  now = Math.floor(Date.now() / 1000),
  maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
}) {
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing webhook-id / webhook-timestamp / webhook-signature header' };
  }

  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) {
    return { ok: false, reason: 'webhook-timestamp is not a valid integer' };
  }
  if (Math.abs(now - ts) > maxSkewSeconds) {
    return { ok: false, reason: `stale webhook timestamp (|now-ts| > ${maxSkewSeconds}s)` };
  }

  if (!keys || keys.length === 0) {
    return { ok: false, reason: 'no verification keys available' };
  }

  const encoder = new TextEncoder();
  const bodyBytes = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const signedContent = new Uint8Array(prefix.length + bodyBytes.length);
  signedContent.set(prefix, 0);
  signedContent.set(bodyBytes, prefix.length);

  const candidates = signatureHeader.trim().split(/\s+/);
  for (const candidate of candidates) {
    const commaIdx = candidate.indexOf(',');
    if (commaIdx === -1) continue;
    const version = candidate.slice(0, commaIdx);
    const encodedSig = candidate.slice(commaIdx + 1);
    if (version !== 'v1a' || !encodedSig) continue;

    let sigBytes;
    try {
      sigBytes = base64ToBytes(encodedSig);
    } catch {
      continue;
    }

    for (const key of keys) {
      try {
        const valid = await crypto.subtle.verify('Ed25519', key, sigBytes, signedContent);
        if (valid) return { ok: true };
      } catch {
        // try next key
      }
    }
  }

  return { ok: false, reason: 'no matching valid v1a signature found' };
}

/**
 * Convenience: fetch keys (or use a provided jwks) and verify in one call.
 * Suitable for direct use in a Cloudflare Worker `fetch` handler.
 */
export async function verifyAnywayWebhook({
  id,
  timestamp,
  signatureHeader,
  rawBody,
  jwks,
  jwksUrl,
  fetchImpl = fetch,
  now,
  maxSkewSeconds,
}) {
  const doc = jwks ?? (await fetchSigningKeys(fetchImpl, jwksUrl ?? SIGNING_KEY_URL));
  const keys = await importVerificationKeys(doc);
  return verifyWebhookSignature({ id, timestamp, signatureHeader, rawBody, keys, now, maxSkewSeconds });
}
