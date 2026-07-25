# AEGIS — Deployment & Secure Key Handling

## Where to put your `ANTHROPIC_API_KEY` (securely)

**Golden rules**
- The key is **only ever an environment variable / platform secret**. It is never
  written into code, never committed to git (`.env` is git-ignored), and never
  sent over chat/email.
- **You set it yourself** at deploy time. I never need to see it — AEGIS reads it
  from the environment at runtime. The moment it's present, reasoning routes to
  Claude automatically; nothing else changes.
- Rotate it any time from your Anthropic console without redeploying code.

Pick the row matching where we deploy the orchestration layer:

| Target | How to set the key securely |
|--------|-----------------------------|
| **Local / your own VM** | Create `.env` (copy from `.env.example`), put the key there. `.env` is git-ignored. Or export it in the shell / systemd unit `Environment=`. |
| **Cloudflare Workers** | `npx wrangler secret put ANTHROPIC_API_KEY` — stored encrypted, not in code. |
| **AWS Lambda** | Store in **AWS Secrets Manager** (or SSM Parameter Store, `SecureString`); the function reads it at cold start. Avoid plain Lambda env vars for long-lived secrets. |
| **Vercel** | Project → Settings → Environment Variables → add `ANTHROPIC_API_KEY` as an *Encrypted* / *Sensitive* var. |
| **Docker** | Pass via `--env-file .env` or a Docker/Swarm/K8s **secret** — not in the image. |

> Recommendation for your case (serverless, enterprise account): AWS Secrets
> Manager or Cloudflare Workers secrets. Both keep the key encrypted at rest and
> out of source control, and your data flows entirely under your corporate
> Anthropic agreement.

Same pattern applies to the per-site webhook secrets (`SITE_SECRET__<site_id>`).

---

## Ticket JSON schema (AEGIS ingest / callback / resolve)

These are the fields AEGIS uses today. **Please confirm or send your ticketing
system's real field names** and I'll map 1:1 so integration is plug-and-play.

### 1. Your site → AEGIS — ticket created
`POST /api/v1/tickets/ingest`
Headers: `X-AEGIS-Signature`, `X-AEGIS-Timestamp`
```json
{
  "site_id": "store-eu",
  "external_ticket_id": "ZD-48213",
  "subject": "Locked out - reset email not arriving",
  "body": "Full ticket text / description from the customer.",
  "requester": "customer@example.com"
}
```

### 2. AEGIS → your ticket panel — signed suggestion
`POST {your callback_url}`  (signed the same way)
```json
{
  "event": "ticket.suggestion",
  "site_id": "store-eu",
  "external_ticket_id": "ZD-48213",
  "category": "Access / Login",
  "priority": "Urgent",
  "draft_response": "Hi ..., here's what resolved a very similar case ...",
  "reasoning": "Matched 2 past cases in memory; reused the closest resolution.",
  "used_memory": [
    { "id": "TKT-1001", "score": 0.63, "subject": "Cannot log in - reset not arriving" }
  ]
}
```
Your panel displays `category` / `priority` / `draft_response` on the ticket for
staff to review. Nothing is auto-sent.

### 3. Your site → AEGIS — staff approved / resolved
`POST /api/v1/tickets/resolve`  (signed)
```json
{
  "site_id": "store-eu",
  "external_ticket_id": "ZD-48213",
  "resolution": "Final approved answer that solved it.",
  "category": "Access / Login",
  "requester": "customer@example.com"
}
```
AEGIS writes this into vector memory — the learning loop.

### Signing (both directions)
```
signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
```
Sent as `X-AEGIS-Signature`, with the unix `X-AEGIS-Timestamp`. Reject if the
timestamp is older than 5 minutes (replay protection). Live example any time at
`GET /api/v1/signature-helper`.
