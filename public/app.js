const $ = s => document.querySelector(s);
const api = (p, opts) => fetch(p, opts).then(r => r.json());
const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Tabs
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'memory') loadMemory();
  if (t.dataset.tab === 'kb') loadKB();
  if (t.dataset.tab === 'schedule') loadCalendar();
});

// Health
api('/api/health').then(h => {
  const s = $('#status');
  s.textContent = `● online · LLM: ${h.llm} · memory: ${h.memory}`;
  s.classList.add('ok');
}).catch(() => $('#status').textContent = 'offline');

// ---- Triage ----
const SAMPLE = {
  requester: 'Mohammed R.',
  subject: 'Locked out — password reset email never arrives',
  body: 'I have been trying to reset my password for an hour. The reset email never shows up in my inbox and I am completely locked out. This is urgent, I have a deadline today.',
};
$('#t-sample').onclick = () => { $('#t-req').value = SAMPLE.requester; $('#t-sub').value = SAMPLE.subject; $('#t-body').value = SAMPLE.body; };

$('#t-submit').onclick = async () => {
  const subject = $('#t-sub').value.trim(), body = $('#t-body').value.trim();
  if (!subject || !body) return alert('Subject and message are required.');
  $('#t-submit').disabled = true; $('#t-submit').textContent = 'AI thinking…';
  try {
    await api('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body, requester: $('#t-req').value.trim() }) });
    $('#t-sub').value = ''; $('#t-body').value = ''; $('#t-req').value = '';
    loadQueue();
  } finally { $('#t-submit').disabled = false; $('#t-submit').textContent = 'Run AI triage'; }
};

async function loadQueue() {
  const tickets = await api('/api/tickets');
  const q = $('#queue');
  if (!tickets.length) { q.innerHTML = '<p class="empty">No tickets yet.</p>'; return; }
  q.innerHTML = tickets.map(renderTicket).join('');
  q.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => approve(b.dataset.approve));
}

function renderTicket(t) {
  const cites = (t.retrieved || []).map(r => `<b>${r.id}</b> (${r.subject || '—'}, ${(r.score * 100).toFixed(0)}%)`).join(', ');
  const closed = t.status === 'closed';
  return `<div class="ticket ${closed ? 'closed' : ''}">
    <div class="head">
      <div><div class="subj">${esc(t.subject)}</div><div class="from">${t.id} · from ${esc(t.requester)}</div></div>
    </div>
    <div class="badges">
      <span class="badge cat">${esc(t.category)}</span>
      <span class="badge p-${t.priority}">${t.priority}</span>
      ${closed ? '<span class="badge tick-closed">✓ closed → saved to memory</span>' : ''}
    </div>
    <div class="reasoning">${esc(t.ai?.reasoning || '')}</div>
    ${cites ? `<div class="cites">Learned from: ${cites}</div>` : '<div class="cites">No prior match — this will teach the AI once closed.</div>'}
    <div class="draft" ${closed ? '' : 'contenteditable="true"'} id="draft-${t.id}">${esc(t.finalResponse || t.ai?.draft_response || '')}</div>
    ${closed ? '' : `<div class="row"><button class="primary small" data-approve="${t.id}">Approve &amp; close (save to memory)</button></div>`}
  </div>`;
}

async function approve(id) {
  const resolution = $('#draft-' + id).innerText;
  await api(`/api/tickets/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution }) });
  loadQueue();
  api('/api/health').then(h => { const s = $('#status'); s.textContent = `● online · LLM: ${h.llm} · memory: ${h.memory}`; });
}

// ---- Memory ----
async function loadMemory() {
  const items = await api('/api/memory');
  $('#mem-count').textContent = items.length;
  $('#mem-list').innerHTML = items.map(m => `<div class="mem-item">
    <div class="subj">${esc(m.metadata?.subject || m.text.slice(0, 60))}</div>
    <span class="badge cat">${esc(m.metadata?.category || 'General')}</span>
    <div class="res">Resolution: ${esc(m.metadata?.resolution || '—')}</div>
  </div>`).join('') || '<p class="empty">Memory is empty.</p>';
}

// ---- KB ----
async function loadKB() {
  const [cands, articles] = await Promise.all([api('/api/kb/candidates'), api('/api/kb')]);
  $('#kb-candidates').innerHTML = cands.length ? cands.map(c => `<div class="cand">
    <div class="theme">${esc(c.theme)}</div>
    <div class="hint">Seen ${c.count} times · tickets: ${c.ids.join(', ')}</div>
    <button class="primary small" data-theme="${esc(c.theme)}">Auto-draft KB article</button>
  </div>`).join('') : '<p class="empty">No recurring issues detected yet. Close a few similar tickets and they show up here.</p>';
  $('#kb-candidates').querySelectorAll('[data-theme]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Drafting…';
    await api('/api/kb/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: b.dataset.theme }) });
    loadKB();
  });
  $('#kb-articles').innerHTML = articles.length ? articles.map(a => `<div class="cand">
    <div class="theme">${esc(a.title)} <span class="badge cat">${a.status}</span></div>
    <pre class="kb">${esc(a.body)}</pre>
  </div>`).join('') : '<p class="empty">No articles yet.</p>';
}

// ---- Calendar ----
async function loadCalendar() {
  const data = await api('/api/calendar');
  const sel = $('#s-emp');
  if (!sel.options.length) sel.innerHTML = data.employees.map(e => `<option>${esc(e)}</option>`).join('');
  $('#s-events').innerHTML = data.events.length ? data.events.map(e => `<div class="event">
    <span class="emp">${esc(e.employee)}</span> — ${esc(e.title)}<br>
    ${new Date(e.start).toLocaleString()} → ${new Date(e.end).toLocaleTimeString()}<br>
    <span class="hint">${e.status} · ${e.reminder}</span>
  </div>`).join('') : '<p class="empty">No events.</p>';
}

$('#s-book').onclick = async () => {
  const payload = { employee: $('#s-emp').value, title: $('#s-title').value,
    start: $('#s-start').value, end: $('#s-end').value, requester: 'dashboard' };
  if (!payload.start || !payload.end) return alert('Pick start and end times.');
  const r = await api('/api/calendar/book', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
  const box = $('#s-result');
  if (r.ok) { box.className = 'ok-msg'; box.textContent = `✓ Booked ${r.event.id} · reminder set (${r.event.reminder})`; loadCalendar(); }
  else { box.className = 'err-msg'; box.textContent = `✗ Conflict with: ${r.conflicts.map(c => c.title + ' (' + new Date(c.start).toLocaleTimeString() + ')').join(', ')}`; }
};

loadQueue();
