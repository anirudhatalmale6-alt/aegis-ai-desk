# AEGIS AI Desk — POC

A serverless-style AI operations assistant for a company group. It reads tickets,
categorizes and prioritizes them, remembers past solutions (RAG long-term memory),
drafts responses for human approval, auto-drafts Knowledge Base articles for
recurring issues, and books employee appointments with conflict checking.

Built as a proof-of-concept for the ticketing + scheduling + autonomous-knowledge
vision, with a **human-in-the-loop approval gate** on every AI action.

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

## API (also the webhook surface)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/tickets` | Ingest a ticket → triage (categorize, RAG search, draft) |
| POST | `/api/tickets/:id/approve` | Human approves → close → learn (write to memory) |
| GET  | `/api/memory` | View long-term memory |
| GET  | `/api/kb/candidates` | Recurring issues detected |
| POST | `/api/kb/draft` | Auto-draft a KB article |
| POST | `/api/calendar/book` | Book appointment (conflict-checked) |
| GET  | `/api/health` | Status + active LLM/embeddings mode |

## Status

Proof of concept. Human-in-the-loop is on by default and is the recommended
rollout mode before graduating any action to full autonomy.
