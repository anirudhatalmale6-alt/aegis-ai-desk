// AEGIS AI Desk - POC server.
// Serverless-style architecture: this thin orchestration layer is the only thing
// that runs on your side. The "intelligence" lives in the LLM provider's cloud,
// and long-term memory lives in the vector store. Your systems only ever pass
// lightweight text in/out via the API below.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { VectorStore } from './src/vectorstore.js';
import { CalendarStore } from './src/calendar.js';
import { triage as llmTriage, generateKB, llmMode } from './src/llm.js';
import { findRecurring } from './src/kb.js';
import { provider as embedProvider } from './src/embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, 'data');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));

const memory = new VectorStore(join(DATA, 'memory.json'));
const calendar = new CalendarStore(join(DATA, 'calendar.json'));

// Structured store: exact facts (tickets + status). Complements semantic memory.
const TICKETS_PATH = join(DATA, 'tickets.json');
let tickets = existsSync(TICKETS_PATH) ? JSON.parse(readFileSync(TICKETS_PATH, 'utf8')) : [];
const saveTickets = () => writeFileSync(TICKETS_PATH, JSON.stringify(tickets, null, 2));
let employees = [];
const kbArticles = [];

// ---- One-time seed ------------------------------------------------------------
function seed() {
  if (memory.size() > 0 && tickets.length > 0) return;
  const s = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8'));
  employees = s.employees;
  for (const t of s.tickets) {
    memory.upsert(t.id, `${t.subject}. ${t.body}`, {
      category: t.category, resolution: t.resolution, requester: t.requester, subject: t.subject,
    });
    tickets.push({ ...t, status: 'closed', priority: 'Medium', createdAt: 'seed' });
  }
  saveTickets();
  if (calendar.events.length === 0) {
    calendar.events = s.calendar;
    calendar._persist();
  }
}
seed();
if (!employees.length) {
  employees = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8')).employees;
}

let seq = 2000;
const nextId = () => `TKT-${++seq}`;

// ---- API ----------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, llm: llmMode, embeddings: embedProvider, memory: memory.size(), tickets: tickets.length });
});

// Ingest a ticket (this is also the webhook target for Zendesk/Jira/etc.)
// Runs triage: categorize -> RAG search -> draft. Nothing is auto-sent; it waits
// for human approval (the human-in-the-loop gate).
app.post('/api/tickets', async (req, res) => {
  const { subject, body, requester } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });

  const retrieved = memory.search(`${subject}. ${body}`, 3);
  const ticket = { subject, body, requester };
  const ai = await llmTriage(ticket, retrieved);

  const record = {
    id: nextId(),
    subject, body, requester: requester || 'unknown',
    status: 'awaiting_approval',
    category: ai.category,
    priority: ai.priority,
    ai,
    retrieved: retrieved.map(r => ({ id: r.id, score: Number(r.score.toFixed(3)), subject: r.metadata?.subject })),
    createdAt: new Date().toISOString(),
  };
  tickets.unshift(record);
  saveTickets();
  res.json(record);
});

app.get('/api/tickets', (req, res) => res.json(tickets));

// Human approves (optionally edited) response -> ticket closes -> resolution is
// written back into long-term memory so the AI "learns" from it.
app.post('/api/tickets/:id/approve', (req, res) => {
  const t = tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const resolution = (req.body?.resolution || t.ai?.draft_response || '').trim();
  t.status = 'closed';
  t.finalResponse = resolution;
  t.resolvedAt = new Date().toISOString();
  memory.upsert(t.id, `${t.subject}. ${t.body}`, {
    category: t.category, resolution, requester: t.requester, subject: t.subject,
  });
  saveTickets();
  res.json({ ok: true, ticket: t, memorySize: memory.size() });
});

app.get('/api/memory', (req, res) => res.json(memory.all()));

// Autonomous KB: detect recurring issues, draft an article for review.
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

// Scheduling (Google Calendar-style).
app.get('/api/calendar', (req, res) => res.json({ employees, events: calendar.list(req.query.employee) }));
app.post('/api/calendar/book', (req, res) => {
  const { employee, title, start, end, requester } = req.body || {};
  if (!employee || !start || !end) return res.status(400).json({ error: 'employee, start, end required' });
  const result = calendar.book({ employee, title: title || 'Appointment', start, end, requester });
  res.status(result.ok ? 200 : 409).json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AEGIS AI Desk running on http://localhost:${PORT}`);
  console.log(`  LLM: ${llmMode} | Embeddings: ${embedProvider} | Memory: ${memory.size()} items`);
});
