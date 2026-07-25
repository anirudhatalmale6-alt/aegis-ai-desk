// Webhook security + outbound delivery.
// Every inbound webhook is authenticated with an HMAC-SHA256 signature over the
// raw body (enterprise-grade: no shared data in the clear, replay-resistant with
// a timestamp). Every outbound callback to a client site is signed the same way
// so their side can verify it genuinely came from AEGIS.

import crypto from 'node:crypto';

export function sign(secret, body, timestamp) {
  const payload = `${timestamp}.${typeof body === 'string' ? body : JSON.stringify(body)}`;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Constant-time compare to avoid timing attacks.
export function verify(secret, rawBody, header, timestamp, toleranceSec = 300) {
  if (!header || !timestamp) return { ok: false, reason: 'missing signature or timestamp' };
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(age) || age > toleranceSec) return { ok: false, reason: 'stale or invalid timestamp' };
  const expected = sign(secret, rawBody, timestamp);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

// Deliver an outbound callback to a site's ticket panel, signed, with retries and
// exponential backoff. Returns a delivery record for the audit log.
export async function deliver(url, secret, body, { attempts = 3 } = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(body);
  const signature = sign(secret, raw, timestamp);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AEGIS-Signature': signature,
          'X-AEGIS-Timestamp': timestamp,
          'X-AEGIS-Event': body.event || 'ticket.suggestion',
        },
        body: raw,
      });
      if (res.ok) return { ok: true, status: res.status, attempt: i + 1 };
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise(r => setTimeout(r, 150 * Math.pow(2, i)));
  }
  return { ok: false, error: lastErr, attempts };
}
