// WhatsApp (ZapClaw) <-> Typebot relay.
// Adapted from https://zapclaw.app/typebot-whatsapp-official-api.html
// Node.js 20+; configuration is supplied through environment variables.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const API_KEY = process.env.ZAPCLAW_API_KEY || '';
const SIGNING_SECRET = process.env.ZAPCLAW_SECRET || '';
const TYPEBOT_ID = process.env.TYPEBOT_PUBLIC_ID || 'assistente-felipe-f1w96o8';
const TYPEBOT_API = process.env.TYPEBOT_API || 'https://typebot.co/api';
const PORT = Number(process.env.PORT || 10000);
// Safety: do not answer any real contacts until an explicit test sender is set.
// Enter country code + area code + number, digits only (e.g. 5521999999999).
const TEST_PHONE = (process.env.TEST_PHONE || '').replace(/\D/g, '');

const sessions = new Map();
const queues = new Map();

function verifySignature(raw, signature) {
  if (!SIGNING_SECRET || !signature) return false;
  const hmac = createHmac('sha256', SIGNING_SECRET).update(raw).digest('hex');
  const expected = Buffer.from(`sha256=${hmac}`);
  const received = Buffer.from(String(signature));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function typebot(path, body) {
  const response = await fetch(`${TYPEBOT_API}/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, textBubbleContentFormat: 'markdown' }),
  });
  if (!response.ok) {
    console.error('Typebot HTTP status:', response.status);
    return null;
  }
  return response.json();
}

async function sendText(from, to, content) {
  const response = await fetch('https://api.zapclaw.app/api/v1/send/text', {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, text: content }),
  });
  if (!response.ok) console.error('ZapClaw send HTTP status:', response.status);
}

async function answer({ data, account }) {
  const sender = String(data.from || '').replace(/\D/g, '');
  if (!TEST_PHONE || sender !== TEST_PHONE) return; // Test-only: ignore all other contacts.
  if (!API_KEY || !TYPEBOT_ID) return;

  const customerKey = data.user_id || data.from;
  const from = account.display_phone_number || account.phone_number_id;
  const to = data.from || data.user_id;
  const previous = sessions.get(customerKey);
  let reply = null;
  if (previous) {
    const typed = String(data.text.body || '').trim();
    const choice = (previous.choices || []).find(
      (label, i) => typed === String(i + 1) || typed.toLowerCase() === label.toLowerCase()
    );
    reply = await typebot(`sessions/${previous.id}/continueChat`, {
      message: { type: 'text', text: choice || typed },
    });
  }
  if (!reply) {
    reply = await typebot(`typebots/${TYPEBOT_ID}/startChat`, {
      message: { type: 'text', text: String(data.text.body || '').trim() },
      prefilledVariables: { name: data.contact_name || '', phone: to },
    });
    if (!reply) return;
  }
  const choices = reply.input?.type === 'choice input'
    ? (reply.input.items || []).map((item) => item.content).filter(Boolean)
    : [];
  if (reply.input && (reply.sessionId || previous?.id)) {
    sessions.set(customerKey, { id: reply.sessionId || previous.id, choices });
  } else {
    sessions.delete(customerKey);
  }
  const messages = (reply.messages || [])
    .filter((m) => m.type === 'text' && typeof m.content?.markdown === 'string')
    .map((m) => m.content.markdown
      .replace(/\*\*(.+?)\*\*/g, (_, t) => `*${t}*`)
      .replace(/~~(.+?)~~/g, (_, t) => `~${t}~`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, title, url) => `${title} (${url})`));
  if (choices.length) messages.push(choices.map((label, i) => `${i + 1}. ${label}`).join('\n'));
  for (const message of messages) if (message) await sendText(from, to, message);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Relay online');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let length = 0;
  req.on('data', (chunk) => {
    length += chunk.length;
    if (length > 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, req.headers['x-zapclaw-signature'])) {
      res.writeHead(401).end('Invalid webhook signature');
      return;
    }
    res.writeHead(200).end('ok');
    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return; }
    if (event.event !== 'message.received' || event.data?.type !== 'text') return;
    const key = event.data.user_id || event.data.from;
    const task = (queues.get(key) || Promise.resolve())
      .then(() => answer(event))
      .catch((error) => console.error('Relay error:', error))
      .finally(() => { if (queues.get(key) === task) queues.delete(key); });
    queues.set(key, task);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Relay online on port ${PORT}; test mode ${TEST_PHONE ? 'enabled' : 'inactive (TEST_PHONE missing)'}`));
