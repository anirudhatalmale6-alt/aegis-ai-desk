# AEGIS AI Desk — POC

A **background** AI operations service for a company group. AEGIS is **not** a
ticketing UI — your existing ticketing systems stay the front-end. It integrates
via signed webhooks: it receives created tickets, categorizes/prioritizes them,
remembers past solutions (RAG long-term memory), and pushes a suggested response
back into your own ticket panel. Your staff approve inside your interface; on
approval your system pings AEGIS to write the final resolution to memory (it
learns). It also auto-drafts Knowledge Base articles for recurring issues and
exposes a Google-Calendar-style scheduling API.

```
your site --(webhook: ticket.created, signed)--> AEGIS --(Claude + RAG)--> suggestion
     ^                                                                        |
     |   (signed callback: ticket.suggestion) <-------------------------------+
staff approve in YOUR panel
     |
     +--(webhook: ticket.resolved, signed)--> AEGIS writes resolution to memory
```

The bundled web app is an **Integration Console** that simulates one of your
sites (left) and your ticket panel (right) so the whole round-trip is
demonstrable without wiring your real systems yet.

## Architecture (production mapping)

| Layer | POC (this repo) | Production |
|-------|-----------------|------------|
| Intelligence | pluggable LLM adapter | Anthropic Claude (enterprise API, no training on your data) |
| Semantic memory | local TF-IDF vector store (JSON) | Qdrant / Pinecone managed vector DB |
| Structured facts | JSON (`tickets.json`) | Postgres / your existing DB |
| Orchestration | Node/Express thin layer | serverless functions (Lambda / Cloudflare / Vercel) |
| Ticketing intake | REST + webhook endpoint | Zendesk / Jira / Freshdesk webhooks |
| Scheduling | local calendar store | Google Calendar API (Workspace) |

Your servers only ever pass lightweight text in/out — **zero heavy load on your
infrastructure**. Swapping the fallback adapters for the enterprise Claude key +
managed vector DB is configuration only; no app rewrite.

## Key idea: it learns

Every approved ticket resolution is written back into memory. The next similar
ticket retrieves it and drafts a grounded reply that cites the past cases it
learned from. Recurring problems are detected automatically and turned into
draft KB articles for review.

## Run it

```bash
npm install
# Optional — real Claude reasoning (else a local reasoner runs so the demo works with no key):
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-5
npm start
# open http://localhost:3000
```

Without a key the app runs fully on a local reasoner + local embeddings so you
can test the entire flow immediately. With the key, Claude does the reasoning —
same interface, same UI.

## Integration API

Every webhook is authenticated with an **HMAC-SHA256** signature over the raw
body + a timestamp (replay-protected, ±5 min). See `GET /api/v1/signature-helper`
for a live signing example.

| Direction | Path | Purpose |
|-----------|------|---------|
| your site → AEGIS | `POST /api/v1/tickets/ingest` | Ticket created → returns + pushes suggestion |
| AEGIS → your panel | `POST {your callback_url}` | Signed `ticket.suggestion` callback |
| your site → AEGIS | `POST /api/v1/tickets/resolve` | Staff approved → write resolution to memory |
| read | `GET /api/memory`, `/api/deliveries` | Memory + outbound delivery audit log |
| read | `GET /api/kb/candidates`, `POST /api/kb/draft` | Recurring issues + KB drafting |
| API | `POST /api/calendar/book` | Book appointment (conflict-checked) |
| read | `GET /api/health` | Status + active LLM/embeddings mode |

Demo-only endpoints under `/mock/*` simulate a client site + panel so the
console can drive the full round-trip locally.

## Status

Proof of concept. Human-in-the-loop is on by default and is the recommended
rollout mode before graduating any action to full autonomy.
