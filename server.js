// AEGIS AI Desk - background integration service.
// AEGIS is NOT a ticketing UI. It sits behind your existing ticketing systems:
//
//   your site  --(webhook: ticket.created)-->  AEGIS  --(Claude + RAG)-->  suggestion
//        ^                                                                     |
//        |  (callback: ticket.suggestion, signed) <----------------------------
//   staff approve in YOUR panel
//        |
//        +--(webhook: ticket.resolved)--> AEGIS writes final resolution to memory
//
// This file also ships a self-contained "mock site panel" so the entire loop is
// demonstrable end-to-end without wiring your real sites yet.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { VectorStore } from './src/vectorstore.js';
import { CalendarStore } from './src/calendar.js';
import { triage as llmTriage, generateKB, llmMode } from './src/llm.js';
import { findRecurring } from './src/kb.js';
import { provider as embedProvider } from './src/embeddings.js';
import { sign, verify, deliver } from './src/webhooks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, 'data');
const app = express();

// Capture the raw body so we can verify HMAC signatures over the exact bytes.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.static(join(__dirname, 'public')));

const memory = new VectorStore(join(DATA, 'memory.json'));
const calendar = new CalendarStore(join(DATA, 'calendar.json'));

// --- Site registry (which sites may call us, their callback URL + shared secret) ---
// In production this is your DB. For the POC the demo site's callback points back
// at our own mock panel so you can watch the round-trip.
const PORT = process.env.PORT || 3000;
const SELF = `http://localhost:${PORT}`;
const sites = new Map([
  ['demo-site', { secret: 'demo_shared_secret_change_me', callback_url: `${SELF}/mock/panel/callback` }],
]);

// --- Structured store: exact facts (tickets + status) ---
const TICKETS_PATH = join(DATA, 'tickets.json');
let tickets = existsSync(TICKETS_PATH) ? JSON.parse(readFileSync(TICKETS_PATH, 'utf8')) : [];
const saveTickets = () => writeFileSync(TICKETS_PATH, JSON.stringify(tickets, null, 2));
let employees = [];
const kbArticles = [];
const deliveryLog = [];        // outbound callback audit trail
const mockPanel = [];          // what the "site's ticket panel" received (demo only)

// --- One-time seed ---
function seed() {
  if (memory.size() > 0) return;
  const s = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8'));
  employees = s.employees;
  for (const t of s.tickets) {
    memory.upsert(t.id, `${t.subject}. ${t.body}`, {
      category: t.category, resolution: t.resolution, requester: t.requester, subject: t.subject,
    });
  }
  if (calendar.events.length === 0) { calendar.events = s.calendar; calendar._persist(); }
}
seed();
if (!employees.length) employees = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8')).employees;

// --- Signature gate for inbound webhooks ---
function authWebhook(req, res, next) {
  const site = sites.get(req.body?.site_id) || sites.get(req.query.site_id);
  if (!site) return res.status(401).json({ error: 'unknown site_id' });
  const check = verify(site.secret, req.rawBody, req.get('X-AEGIS-Signature'), req.get('X-AEGIS-Timestamp'));
  if (!check.ok) return res.status(401).json({ error: 'signature verification failed', detail: check.reason });
  req.site = site;
  next();
}

// ======================= AEGIS PUBLIC API (v1) =======================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'aegis-integration', llm: llmMode, embeddings: embedProvider,
    memory: memory.size(), sites: [...sites.keys()] });
});

// Helper: expose a signed example so the client can see exactly how to call us.
app.get('/api/v1/signature-helper', (req, res) => {
  const site = sites.get('demo-site');
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = { site_id: 'demo-site', external_ticket_id: 'EXT-123', subject: '...', body: '...', requester: '...' };
  res.json({
    endpoint: `POST ${SELF}/api/v1/tickets/ingest`,
    headers: { 'X-AEGIS-Signature': sign(site.secret, JSON.stringify(body), ts), 'X-AEGIS-Timestamp': ts },
    note: 'Signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`). Reject if timestamp older than 5 min.',
  });
});

// (1) INBOUND: a ticket was created on a client site.
// Runs RAG + LLM triage, returns the suggestion synchronously AND fires a signed
// callback into the site's ticket panel. Nothing is auto-actioned.
app.post('/api/v1/tickets/ingest', authWebhook, async (req, res) => {
  const { external_ticket_id, subject, body, requester, site_id } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });

  const retrieved = memory.search(`${subject}. ${body}`, 3);
  const ai = await llmTriage({ subject, body, requester }, retrieved);

  const suggestion = {
    event: 'ticket.suggestion',
    site_id, external_ticket_id,
    category: ai.category,
    priority: ai.priority,
    draft_response: ai.draft_response,
    reasoning: ai.reasoning,
    used_memory: retrieved.map(r => ({ id: r.id, score: Number(r.score.toFixed(3)), subject: r.metadata?.subject })),
  };

  // Track it (structured store).
  tickets.unshift({ id: external_ticket_id || `EXT-${Date.now()}`, site_id, subject, body,
    requester: requester || 'unknown', status: 'suggested', category: ai.category, priority: ai.priority,
    ai, createdAt: new Date().toISOString() });
  saveTickets();

  // Fire the outbound callback to the site's panel (async, signed, retried).
  deliver(req.site.callback_url, req.site.secret, suggestion).then(result => {
    deliveryLog.unshift({ at: new Date().toISOString(), to: req.site.callback_url,
      external_ticket_id, ...result });
    if (deliveryLog.length > 50) deliveryLog.pop();
  });

  res.json({ ok: true, suggestion, delivered_to: req.site.callback_url });
});

// (2) INBOUND: staff approved & closed the ticket in THEIR panel.
// AEGIS writes the final resolution into long-term memory ("learns").
app.post('/api/v1/tickets/resolve', authWebhook, (req, res) => {
  const { external_ticket_id, subject, body, resolution, category, requester } = req.body || {};
  if (!external_ticket_id || !resolution) return res.status(400).json({ error: 'external_ticket_id and resolution required' });
  const known = tickets.find(t => t.id === external_ticket_id);
  const subj = subject || known?.subject || external_ticket_id;
  const bod = body || known?.body || '';
  memory.upsert(external_ticket_id, `${subj}. ${bod}`, {
    category: category || known?.category || 'General', resolution,
    requester: requester || known?.requester, subject: subj,
  });
  if (known) { known.status = 'resolved'; known.finalResponse = resolution; saveTickets(); }
  res.json({ ok: true, memory_size: memory.size() });
});

// Read-only views (for the console / your dashboards).
app.get('/api/tickets', (req, res) => res.json(tickets));
app.get('/api/memory', (req, res) => res.json(memory.all()));
app.get('/api/deliveries', (req, res) => res.json(deliveryLog));

// Autonomous KB.
app.get('/api/kb/candidates', (req, res) => res.json(findRecurring(memory.all())));
app.post('/api/kb/draft', async (req, res) => {
  const clusters = findRecurring(memory.all());
  const cluster = clusters.find(c => c.theme === req.body?.theme) || clusters[0];
  if (!cluster) return res.status(404).json({ error: 'no recurring clusters yet' });
  const article = await generateKB(cluster);
  const saved = { id: 'KB-' + (kbArticles.length + 1).toString().padStart(3, '0'), status: 'draft', ...article };
  kbArticles.push(saved);
  res.json(saved);
});
app.get('/api/kb', (req, res) => res.json(kbArticles));

// Scheduling (Google Calendar-style) - exposed for your systems to call.
app.get('/api/calendar', (req, res) => res.json({ employees, events: calendar.list(req.query.employee) }));
app.post('/api/calendar/book', (req, res) => {
  const { employee, title, start, end, requester } = req.body || {};
  if (!employee || !start || !end) return res.status(400).json({ error: 'employee, start, end required' });
  const result = calendar.book({ employee, title: title || 'Appointment', start, end, requester });
  res.status(result.ok ? 200 : 409).json(result);
});

// ======================= DEMO-ONLY: mock "site" side =======================
// Simulates one of your websites so the console can drive the full round-trip.

// The console asks the mock site to "create a ticket" -> it signs & POSTs to AEGIS.
app.post('/mock/site/create-ticket', async (req, res) => {
  const site = sites.get('demo-site');
  const payload = { site_id: 'demo-site', external_ticket_id: req.body.external_ticket_id || `EXT-${Date.now()}`,
    subject: req.body.subject, body: req.body.body, requester: req.body.requester };
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(payload);
  const r = await fetch(`${SELF}/api/v1/tickets/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AEGIS-Signature': sign(site.secret, raw, ts), 'X-AEGIS-Timestamp': ts },
    body: raw,
  });
  res.status(r.status).json(await r.json());
});

// AEGIS calls this back = "your ticket panel receives the AI suggestion".
app.post('/mock/panel/callback', (req, res) => {
  const site = sites.get(req.body?.site_id);
  const check = site ? verify(site.secret, req.rawBody, req.get('X-AEGIS-Signature'), req.get('X-AEGIS-Timestamp')) : { ok: false };
  mockPanel.unshift({ receivedAt: new Date().toISOString(), verified: check.ok, suggestion: req.body });
  if (mockPanel.length > 50) mockPanel.pop();
  res.json({ ok: true, verified: check.ok });
});
app.get('/mock/panel', (req, res) => res.json(mockPanel));

// Staff approve in the mock panel -> mock site signs & pings AEGIS resolve.
app.post('/mock/site/resolve', async (req, res) => {
  const site = sites.get('demo-site');
  const payload = { site_id: 'demo-site', external_ticket_id: req.body.external_ticket_id,
    resolution: req.body.resolution, category: req.body.category };
  const ts = Math.floor(Date.now() / 1000).toString();
  const raw = JSON.stringify(payload);
  const r = await fetch(`${SELF}/api/v1/tickets/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AEGIS-Signature': sign(site.secret, raw, ts), 'X-AEGIS-Timestamp': ts },
    body: raw,
  });
  res.status(r.status).json(await r.json());
});

app.listen(PORT, () => {
  console.log(`AEGIS integration service on ${SELF}`);
  console.log(`  LLM: ${llmMode} | Embeddings: ${embedProvider} | Memory: ${memory.size()} | Sites: ${[...sites.keys()].join(', ')}`);
});
