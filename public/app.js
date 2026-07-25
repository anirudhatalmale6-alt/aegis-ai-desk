const $ = s => document.querySelector(s);
const api = (p, opts) => fetch(p, opts).then(r => r.json());
const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const jpost = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#' + t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 'memory') loadMemory();
  if (t.dataset.tab === 'kb') loadKB();
  if (t.dataset.tab === 'schedule') loadCalendar();
  if (t.dataset.tab === 'api') loadApi();
});

function refreshStatus() {
  return api('/api/health').then(h => {
    const s = $('#status');
    s.textContent = `● online · LLM: ${h.llm} · memory: ${h.memory} · sites: ${h.sites.join(',')}`;
    s.classList.add('ok');
  }).catch(() => $('#status').textContent = 'offline');
}
refreshStatus();

// ---- Integration Flow ----
const SAMPLE = { requester: 'Mohammed R.', subject: 'Locked out — password reset email never arrives',
  body: 'I have been trying to reset my password for an hour. The reset email never arrives and I am completely locked out. Urgent — I have a deadline today.' };
$('#f-sample').onclick = () => { $('#f-req').value = SAMPLE.requester; $('#f-sub').value = SAMPLE.subject; $('#f-body').value = SAMPLE.body; };

let currentTicket = null;

$('#f-send').onclick = async () => {
  const subject = $('#f-sub').value.trim(), body = $('#f-body').value.trim();
  if (!subject || !body) return alert('Subject and message required.');
  const extId = 'EXT-' + Math.floor(Date.now() / 1000);
  $('#f-send').disabled = true; $('#f-send').textContent = 'Signing & sending…';
  $('#f-sent').innerHTML = `<div class="step">→ POST /api/v1/tickets/ingest<br><span class="dim">signed HMAC-SHA256 · ${extId}</span></div>`;
  $('#f-aegis').innerHTML = '<span class="dim">verifying signature…<br>RAG search…<br>triage…</span>';
  try {
    const r = await jpost('/mock/site/create-ticket', { external_ticket_id: extId, subject, body, requester: $('#f-req').value.trim() });
    const s = r.suggestion;
    currentTicket = { extId, subject, body, category: s.category };
    const cites = (s.used_memory || []).map(m => `<b>${m.id}</b> (${(m.score * 100).toFixed(0)}%)`).join(', ') || 'none — new issue';
    $('#f-aegis').innerHTML = `<div class="step ok">✓ signature verified</div>
      <div class="badges"><span class="badge cat">${esc(s.category)}</span><span class="badge p-${s.priority}">${s.priority}</span></div>
      <div class="dim">${esc(s.reasoning || '')}</div>
      <div class="cites">learned from: ${cites}</div>
      <div class="step ok">→ signed callback pushed to your panel</div>`;
    await loadPanel();
    refreshStatus();
  } finally { $('#f-send').disabled = false; $('#f-send').textContent = 'Fire webhook → AEGIS'; }
};

async function loadPanel() {
  const panel = await api('/mock/panel');
  if (!panel.length) { $('#f-panel').innerHTML = '<span class="empty">No suggestions received yet.</span>'; return; }
  $('#f-panel').innerHTML = panel.slice(0, 4).map((p, i) => {
    const s = p.suggestion;
    const approvable = i === 0 && currentTicket && s.external_ticket_id === currentTicket.extId;
    return `<div class="pcard">
      <div class="from">${esc(s.external_ticket_id)} · ${p.verified ? '<span class="ver">✓ verified</span>' : '<span class="unver">unverified</span>'}</div>
      <div class="subj">${esc(currentTicket && s.external_ticket_id === currentTicket.extId ? currentTicket.subject : s.category)}</div>
      <div class="badges"><span class="badge cat">${esc(s.category)}</span><span class="badge p-${s.priority}">${s.priority}</span></div>
      <div class="draft-mini">${esc(s.draft_response)}</div>
      ${approvable ? `<button class="primary small" id="approve-btn">Staff approve → AEGIS learns</button>` : ''}
    </div>`;
  }).join('');
  const btn = $('#approve-btn');
  if (btn) btn.onclick = approve;
}

async function approve() {
  const t = currentTicket;
  const panel = await api('/mock/panel');
  const resolution = panel[0]?.suggestion?.draft_response || 'Resolved.';
  $('#approve-btn').disabled = true; $('#approve-btn').textContent = 'Writing to memory…';
  const r = await jpost('/mock/site/resolve', { external_ticket_id: t.extId, resolution, category: t.category });
  $('#f-panel').insertAdjacentHTML('afterbegin', `<div class="step ok">✓ resolved on your side → AEGIS memory now ${r.memory_size} items</div>`);
  refreshStatus();
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
  </div>`).join('') : '<p class="empty">No recurring issues yet. Resolve a few similar tickets and they appear here.</p>';
  $('#kb-candidates').querySelectorAll('[data-theme]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Drafting…';
    await jpost('/api/kb/draft', { theme: b.dataset.theme });
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
    <span class="hint">${e.status} · ${e.reminder}</span></div>`).join('') : '<p class="empty">No events.</p>';
}
$('#s-book').onclick = async () => {
  const payload = { employee: $('#s-emp').value, title: $('#s-title').value, start: $('#s-start').value, end: $('#s-end').value, requester: 'api' };
  if (!payload.start || !payload.end) return alert('Pick start and end times.');
  const r = await jpost('/api/calendar/book', payload);
  const box = $('#s-result');
  if (r.ok) { box.className = 'ok-msg'; box.textContent = `✓ Booked ${r.event.id} · reminder ${r.event.reminder}`; loadCalendar(); }
  else { box.className = 'err-msg'; box.textContent = `✗ Conflict: ${r.conflicts.map(c => c.title + ' (' + new Date(c.start).toLocaleTimeString() + ')').join(', ')}`; }
};

// ---- API tab ----
async function loadApi() {
  const [helper, dels] = await Promise.all([api('/api/v1/signature-helper'), api('/api/deliveries')]);
  $('#sig-helper').textContent = JSON.stringify(helper, null, 2);
  $('#deliveries').innerHTML = dels.length ? dels.map(d => `<div class="event">
    <span class="${d.ok ? 'ver' : 'unver'}">${d.ok ? '✓ delivered' : '✗ failed'}</span> ${esc(d.external_ticket_id || '')}
    <span class="hint">→ ${esc(d.to)} · attempt ${d.attempt || d.attempts} · ${esc(d.at)}</span></div>`).join('') : '<p class="empty">No deliveries yet.</p>';
}

loadPanel();
