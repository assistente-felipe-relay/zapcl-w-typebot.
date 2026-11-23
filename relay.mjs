// ZapClaw <-> Typebot relay | Versao de teste 2
// 20 s de agrupamento + encaminhamento autenticado por /handoff.
// Nenhum contato fora de TEST_PHONE recebe resposta ate ALLOW_ALL_CONTACTS=true.
// Handoffs desativados por padrao ate HANDOFF_ENABLED=true.
// Requer Node.js 20+; nao registre segredos nem conteudos clinicos nos logs.

import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const env = process.env;
const PORT = Number(env.PORT || 10000);
const API = env.ZAPCLAW_API_BASE || 'https://api.zapclaw.app/api/v1';
const API_KEY = env.ZAPCLAW_API_KEY || '';
const WEBHOOK_SECRET = env.ZAPCLAW_SECRET || '';
const TYPEBOT_API = env.TYPEBOT_API || 'https://typebot.co/api';
const TYPEBOT_ID = env.TYPEBOT_PUBLIC_ID || 'assistente-felipe-f1w96o8';
const TEST_PHONE = digits(env.TEST_PHONE);
const ALLOW_ALL = env.ALLOW_ALL_CONTACTS === 'true';
const DEBOUNCE_MS = Math.min(45000, Math.max(5000, Number(env.DEBOUNCE_MS || 20000)));
const SEND_DELAY_MS = Math.min(8000, Math.max(0, Number(env.SEND_DELAY_MS || 2500)));
const HANDOFF_ENABLED = env.HANDOFF_ENABLED === 'true';
const HANDOFF_SECRET = env.HANDOFF_SECRET || '';
const CLINIC_PHONE = digits(env.CLINIC_PHONE || '5521970617018');
const PERSONAL_PHONE = digits(env.PERSONAL_PHONE);
const HANDOFF_TEST_TO = digits(env.HANDOFF_TEST_TO);
const NOTIFICATION_DRY_RUN = env.NOTIFICATION_DRY_RUN !== 'false';
const SILENCE_TOKEN = '[[SEM_RESPOSTA]]';

const sessions = new Map();
const pending = new Map();
const processing = new Map();
const recentMessageIds = new Map();
const recentHandoffs = new Map();

function digits(x) { return String(x || '').replace(/\D/g, ''); }
// A Meta pode representar alguns numeros BR sem o 9o digito.
function comparePhone(x) {
  const n = digits(x);
  return n.length === 13 && n.startsWith('55') && n[4] === '9'
    ? n.slice(0, 4) + n.slice(5) : n;
}
function equalPhone(a, b) { return !!a && !!b && comparePhone(a) === comparePhone(b); }
function secretMatches(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
function verifyWebhook(raw, header) {
  if (!WEBHOOK_SECRET) return false;
  const digest = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return secretMatches(header, `sha256=${digest}`);
}
function normalizeText(s) { return String(s || '').trim().slice(0, 16000); }
function formatWhatsapp(s) {
  return normalizeText(s)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, maxBytes = 32768) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maxBytes) throw new Error('body_too_large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function typebot(path, payload) {
  const response = await fetch(`${TYPEBOT_API}/v1/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, textBubbleContentFormat: 'markdown' }),
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) throw new Error(`typebot_${response.status}`);
  return response.json();
}
async function sendText(from, to, text, uniqueId) {
  if (!API_KEY) throw new Error('missing_zapclaw_api_key');
  const response = await fetch(`${API}/send/text`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(uniqueId),
    },
    body: JSON.stringify({ from, to, text: normalizeText(text).slice(0, 4096) }),
    signal: AbortSignal.timeout(25000),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 201) return { ok: true, body };
  if (response.status === 202) return { ok: false, indeterminate: true, status: 202, body };
  return { ok: false, status: response.status, body };
}
function idempotencyKey(id) {
  const h = createHash('sha256').update(String(id)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function rememberOnce(map, key, ttlMs) {
  const now = Date.now();
  for (const [item, until] of map) if (until < now) map.delete(item);
  if (map.has(key)) return false;
  map.set(key, now + ttlMs);
  return true;
}
async function processConversation(key, batch) {
  const { event, texts, seq, ids } = batch;
  const { data, account } = event;
  const customer = data.user_id || data.from;
  const to = data.from || data.user_id;
  const from = digits(account?.display_phone_number);
  if (!from || !to || !API_KEY) return;
  const allText = texts.join('\n');
  const previous = sessions.get(key);
  let reply;
  try {
    if (previous) {
      const choice = (previous.choices || []).find((x, i) =>
        allText === String(i + 1) || allText.toLowerCase() === x.toLowerCase());
      try {
        reply = await typebot(`sessions/${encodeURIComponent(previous.id)}/continueChat`, {
          message: { type: 'text', text: choice || allText },
        });
      } catch (err) {
        // So se a sessao expirou, iniciar outra com a mensagem atual.
        if (err.message !== 'typebot_404') throw err;
      }
    }
    if (!reply) {
      reply = await typebot(`typebots/${encodeURIComponent(TYPEBOT_ID)}/startChat`, {
        message: { type: 'text', text: allText },
        prefilledVariables: { name: data.contact_name || '', phone: to },
      });
    }
    const choices = reply.input?.type === 'choice input'
      ? (reply.input.items || []).map((item) => item.content).filter(Boolean) : [];
    if (reply.input && (reply.sessionId || previous?.id)) {
      sessions.set(key, { id: reply.sessionId || previous.id, choices });
    } else sessions.delete(key);

    let messages = (reply.messages || [])
      .filter((m) => m.type === 'text' && typeof m.content?.markdown === 'string')
      .map((m) => formatWhatsapp(m.content.markdown));
    if (choices.length) messages.push(choices.map((x, i) => `${i + 1}. ${x}`).join('\n'));
    messages = messages.filter((m) => m && m.trim().toUpperCase() !== SILENCE_TOKEN);
    if (!messages.length) return;

    // Se o contato continuou escrevendo enquanto a IA pensava, descarte a resposta velha.
    if ((pending.get(key)?.seq || 0) > seq) return;
    if (SEND_DELAY_MS) await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    if ((pending.get(key)?.seq || 0) > seq) return;

    for (let i = 0; i < messages.length; i++) {
      const result = await sendText(from, to, messages[i], `${key}/${ids.join('-')}/answer/${i}`);
      if (!result.ok) {
        console.error('whatsapp_reply_failed', result.status || 'unknown');
        break;
      }
    }
  } catch (err) {
    console.error('conversation_error', err.message);
  }
}
function enqueueIncoming(event) {
  const { data, account } = event;
  const sender = digits(data?.from);
  if (!ALLOW_ALL && (!TEST_PHONE || !equalPhone(TEST_PHONE, sender))) return;
  if (equalPhone(sender, account?.display_phone_number)) return;
  // Evitar ativar respostas automaticas aos destinos de notificacao.
  if (equalPhone(sender, CLINIC_PHONE) || equalPhone(sender, PERSONAL_PHONE)) return;
  const id = `${account.phone_number_id}:${data.message_id}`;
  if (!data.message_id || !rememberOnce(recentMessageIds, id, 10 * 60 * 1000)) return;
  const key = `${account.phone_number_id}:${data.user_id || data.from}`;
  const text = normalizeText(data.text?.body);
  if (!text) return;
  let entry = pending.get(key);
  if (!entry) entry = { texts: [], ids: [], seq: 0, timer: null, event };
  entry.texts.push(text);
  entry.ids.push(data.message_id);
  entry.event = event;
  entry.seq++;
  if (entry.timer) clearTimeout(entry.timer);
  const selectedSeq = entry.seq;
  entry.timer = setTimeout(() => {
    const existing = pending.get(key);
    if (!existing || existing.seq !== selectedSeq) return;
    const batch = { event: existing.event, texts: existing.texts.splice(0), ids: existing.ids.splice(0), seq: selectedSeq };
    existing.timer = null;
    const earlier = processing.get(key) || Promise.resolve();
    const run = earlier.catch(() => {}).then(() => processConversation(key, batch));
    processing.set(key, run);
    run.finally(() => { if (processing.get(key) === run) processing.delete(key); });
  }, DEBOUNCE_MS);
  pending.set(key, entry);
}

function safeLine(s, max = 350) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}
function buildHandoffMessage(p, kind) {
  const name = safeLine(p.name, 90) || 'Nao informado';
  const phone = digits(p.phone) || 'Nao informado';
  if (kind === 'lead') {
    return ['LEAD PARA CLINICA NEXUS', `Nome: ${name}`, `Telefone: ${phone}`,
      `Objetivo: ${safeLine(p.goal)}`, `Dificuldades: ${safeLine(p.difficulties)}`,
      `Servico de interesse: ${safeLine(p.service)}`, `Indicacao: ${safeLine(p.referral)}`,
      `Preferencia de dias/horarios: ${safeLine(p.availability)}`,
      `Objeções: ${safeLine(p.objections)}`, `Status: ${safeLine(p.status || 'interesse confirmado')}`,
      `Observacoes comerciais: ${safeLine(p.notes, 500)}`].join('\n');
  }
  return ['SOLICITACAO DE SUPORTE', `Paciente: ${name}`, `Telefone: ${phone}`,
    `Categoria: ${safeLine(p.category)}`, `Duvida confirmada: ${safeLine(p.problem, 450)}`,
    `Informacoes essenciais: ${safeLine(p.context, 450)}`,
    `Print: ${safeLine(p.attachmentReference || 'verificar com o paciente')}`,
    'Paciente confirmou o entendimento: SIM', `Acao solicitada: ${safeLine(p.action, 250)}`].join('\n');
}
async function handleHandoff(req, res) {
  if (!HANDOFF_SECRET || !secretMatches(req.headers['x-relay-token'], HANDOFF_SECRET)) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (!HANDOFF_ENABLED) return json(res, 403, { ok: false, error: 'handoffs_disabled' });
  let p;
  try { p = JSON.parse((await readBody(req, 25000)).toString('utf8')); }
  catch { return json(res, 400, { ok: false, error: 'invalid_json' }); }
  const kind = p.kind;
  if (!['lead', 'followup', 'support'].includes(kind)) return json(res, 400, { ok: false, error: 'invalid_kind' });
  if (!p.requestId || !p.name || !p.phone) return json(res, 400, { ok: false, error: 'missing_required_fields' });
  if ((kind === 'support' || kind === 'lead') && p.confirmed !== true) return json(res, 400, { ok: false, error: 'not_confirmed' });
  if (kind === 'followup' && p.optInFollowup !== true) return json(res, 400, { ok: false, error: 'followup_without_optin' });
  const from = digits(env.WHATSAPP_FROM);
  if (!from) return json(res, 500, { ok: false, error: 'WHATSAPP_FROM_missing' });
  const to = HANDOFF_TEST_TO || (kind === 'support' ? PERSONAL_PHONE : CLINIC_PHONE);
  if (!to) return json(res, 422, { ok: false, error: 'destination_missing' });
  if (equalPhone(from, to)) return json(res, 422, { ok: false, error: 'cannot_send_to_same_number' });
  if (!ALLOW_ALL && !NOTIFICATION_DRY_RUN && !HANDOFF_TEST_TO) {
    return json(res, 403, { ok: false, error: 'test_destination_required' });
  }
  const msg = buildHandoffMessage(
    { ...p, status: kind === 'followup' ? 'Lead para follow-up (contato autorizado)' : p.status },
    kind === 'followup' ? 'lead' : kind
  );
  const key = `${kind}:${digits(p.phone)}:${safeLine(p.requestId, 120)}`;
  const alreadySent = recentHandoffs.get(key);
  if (alreadySent) return json(res, 200, { ok: true, duplicate: true, mode: alreadySent });
  if (NOTIFICATION_DRY_RUN) return json(res, 200, {
    ok: true, dryRun: true, destinationMasked: `***${to.slice(-4)}`, kind,
    summaryLength: msg.length,
  });
  const result = await sendText(from, to, msg, `handoff/${key}`);
  if (result.ok) {
    recentHandoffs.set(key, 'sent');
    return json(res, 201, { ok: true, sent: true, kind });
  }
  // Em 202 a entrega e incerta: nunca afirmar que chegou.
  return json(res, result.indeterminate ? 202 : 502, {
    ok: false, status: result.status, indeterminate: !!result.indeterminate,
    error: 'delivery_not_confirmed',
  });
}

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') return json(res, 200, {
    service: 'relay', testOnly: !ALLOW_ALL, debounceMs: DEBOUNCE_MS,
    handoffsEnabled: HANDOFF_ENABLED, notificationDryRun: NOTIFICATION_DRY_RUN,
  });
  if (req.method === 'POST' && req.url === '/handoff') {
    try { return await handleHandoff(req, res); }
    catch (err) { console.error('handoff_error', err.message); return json(res, 500, { ok: false }); }
  }
  if (req.method !== 'POST' || req.url !== '/webhook') return json(res, 404, { ok: false });
  let raw;
  try { raw = await readBody(req, 1024 * 1024); }
  catch { return json(res, 413, { ok: false }); }
  if (!verifyWebhook(raw, req.headers['x-zapclaw-signature'])) {
    return json(res, 401, { ok: false, error: 'invalid_signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { ok: false }); }
  json(res, 200, { ok: true });
  if (event.event === 'message.received' && event.data?.type === 'text' && event.account) {
    enqueueIncoming(event);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('relay_v2_ready', { testOnly: !ALLOW_ALL, debounceMs: DEBOUNCE_MS,
    handoffsEnabled: HANDOFF_ENABLED, notificationDryRun: NOTIFICATION_DRY_RUN });
});
