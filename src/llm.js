// LLM adapter.
// - If ANTHROPIC_API_KEY is set, real Claude does the reasoning (categorize,
//   draft, KB article) via the official SDK.
// - Otherwise a deterministic local reasoner takes over so the demo is fully
//   interactive with no key. It uses the SAME prompt inputs and returns the SAME
//   JSON shape, so switching to the enterprise Claude key changes nothing else.

let anthropic = null;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const hasKey = !!process.env.ANTHROPIC_API_KEY;

if (hasKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export const llmMode = hasKey ? `claude:${MODEL}` : 'local-reasoner';

async function claudeJSON(system, user) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.map(c => c.text || '').join('');
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

// ---- Local reasoner (fallback) ------------------------------------------------

const CATEGORY_RULES = [
  { cat: 'Billing', kw: ['invoice', 'payment', 'charge', 'refund', 'billing', 'subscription', 'price'] },
  { cat: 'Access / Login', kw: ['login', 'password', 'access', 'locked', 'reset', 'sign in', 'account', '2fa', 'mfa'] },
  { cat: 'Bug / Error', kw: ['error', 'crash', 'bug', 'broken', 'fail', 'not working', 'exception', '500', 'freeze'] },
  { cat: 'Hardware', kw: ['printer', 'laptop', 'monitor', 'keyboard', 'device', 'hardware', 'battery'] },
  { cat: 'Network / VPN', kw: ['vpn', 'network', 'wifi', 'internet', 'connection', 'slow', 'dns', 'proxy'] },
  { cat: 'Email', kw: ['email', 'outlook', 'inbox', 'smtp', 'mailbox', 'spam'] },
  { cat: 'Scheduling', kw: ['schedule', 'appointment', 'calendar', 'meeting', 'book', 'shift', 'leave', 'time off'] },
  { cat: 'HR / Admin', kw: ['onboard', 'offboard', 'hr', 'policy', 'salary', 'leave', 'vacation'] },
];

const URGENT = ['urgent', 'asap', 'immediately', 'down', 'outage', 'production', 'cannot work', 'blocked', 'critical', 'all users', 'everyone'];
const HIGH = ['error', 'crash', 'locked out', 'deadline', 'today', 'broken', 'fail'];

function classify(text) {
  const t = text.toLowerCase();
  let best = { cat: 'General', hits: 0 };
  for (const rule of CATEGORY_RULES) {
    const hits = rule.kw.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (hits > best.hits) best = { cat: rule.cat, hits };
  }
  let priority = 'Low', score = 0;
  for (const k of URGENT) if (t.includes(k)) score += 3;
  for (const k of HIGH) if (t.includes(k)) score += 1;
  if (score >= 3) priority = 'Urgent';
  else if (score === 2) priority = 'High';
  else if (score === 1) priority = 'Medium';
  return { category: best.cat, priority };
}

function localTriage(ticket, retrieved) {
  const { category, priority } = classify(`${ticket.subject} ${ticket.body}`);
  const cites = retrieved.map((r, i) => `[${i + 1}]`).join(' ');
  let draft;
  if (retrieved.length) {
    const top = retrieved[0];
    const resolution = top.metadata?.resolution || 'the previously documented steps';
    draft =
`Hi ${ticket.requester || 'there'},

Thanks for reaching out about "${ticket.subject}". We've seen a very similar case before ${cites}, and here's what resolved it:

${resolution}

Please try the above and let us know if the issue persists - happy to escalate if needed.

Best regards,
Support Team`;
  } else {
    draft =
`Hi ${ticket.requester || 'there'},

Thanks for reaching out about "${ticket.subject}". This looks like a ${category.toLowerCase()} issue. We're looking into it and will follow up shortly with next steps. If anything is blocking your work right now, reply here and we'll prioritize it.

Best regards,
Support Team`;
  }
  const reasoning = retrieved.length
    ? `Matched ${retrieved.length} past case(s) in memory; drafted a response reusing the closest known resolution.`
    : `No close match in memory yet - drafted a safe acknowledgement. This ticket's resolution will be saved so future matches improve.`;
  return {
    category,
    priority,
    summary: `${ticket.subject} - classified as ${category} (${priority}).`,
    used_memory: retrieved.map(r => r.id),
    draft_response: draft,
    reasoning,
  };
}

function localKB(cluster) {
  const title = `How to resolve: ${cluster.theme}`;
  const steps = cluster.resolutions.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join('\n');
  return {
    title,
    body:
`# ${title}

## Symptom
Multiple tickets reported: ${cluster.theme}.

## Resolution steps
${steps || '1. (Add resolution steps)'}

## Notes
Auto-drafted from ${cluster.count} related tickets. Review and publish to the Knowledge Base.`,
    source_tickets: cluster.ids,
  };
}

// ---- Public API ---------------------------------------------------------------

export async function triage(ticket, retrieved) {
  if (!anthropic) return localTriage(ticket, retrieved);
  const context = retrieved.map((r, i) =>
    `[${i + 1}] (id=${r.id}, score=${r.score.toFixed(2)}) ${r.text}\n   resolution: ${r.metadata?.resolution || 'n/a'}`
  ).join('\n');
  const system =
`You are an enterprise IT/operations support AI with long-term memory. You categorize tickets, set priority, and draft responses grounded ONLY in retrieved past cases when relevant. Never invent facts. Respond with strict JSON:
{"category":str,"priority":"Low|Medium|High|Urgent","summary":str,"used_memory":[id,...],"draft_response":str,"reasoning":str}`;
  const user =
`New ticket:\nSubject: ${ticket.subject}\nFrom: ${ticket.requester || 'unknown'}\nBody: ${ticket.body}\n\nRetrieved memory (past tickets + resolutions):\n${context || '(none)'}\n\nCategorize, prioritize, and draft a response. Cite which memory ids you used.`;
  try {
    return await claudeJSON(system, user);
  } catch (e) {
    return { ...localTriage(ticket, retrieved), reasoning: `Claude call failed (${e.message}); used local reasoner.` };
  }
}

export async function generateKB(cluster) {
  if (!anthropic) return localKB(cluster);
  const system = 'You draft concise internal Knowledge Base articles from recurring support tickets. Respond with strict JSON: {"title":str,"body":str(markdown),"source_tickets":[id,...]}';
  const user = `Recurring theme: ${cluster.theme}\nTicket count: ${cluster.count}\nKnown resolutions:\n${cluster.resolutions.map((r, i) => `${i + 1}. ${r}`).join('\n')}\nSource ids: ${cluster.ids.join(', ')}`;
  try {
    return await claudeJSON(system, user);
  } catch (e) {
    return localKB(cluster);
  }
}
