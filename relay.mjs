
// WhatsApp Meta Cloud API + ZapClaw + Typebot
// Relay V3 | Node.js 20+

import { interpretMedia } from './media.mjs';
import { supportFields, typebotControls } from './controls.mjs';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const env = process.env;
const PORT = Number(env.PORT || 10000);

const PROVIDER = env.WHATSAPP_PROVIDER || 'meta';

const META_ACCESS_TOKEN = env.META_ACCESS_TOKEN || '';
const META_PHONE_NUMBER_ID = env.META_PHONE_NUMBER_ID || '';
const META_VERIFY_TOKEN = env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = env.META_APP_SECRET || '';
const META_GRAPH_VERSION = env.META_GRAPH_VERSION || 'v23.0';

const IG_ID = env.INSTAGRAM_ACCOUNT_ID || '';
const IG_TOKEN = env.INSTAGRAM_ACCESS_TOKEN || '';
const IG_GRAPH = 'https://graph.instagram.com/' + (env.INSTAGRAM_GRAPH_VERSION || META_GRAPH_VERSION);
const WA_GRAPH = 'https://graph.facebook.com/' + META_GRAPH_VERSION;
const IG_TEST_USERS = new Set((env.INSTAGRAM_TEST_USERS || '').split(',').map(x => x.trim()).filter(Boolean));
const IG_ALLOW_ALL = env.INSTAGRAM_ALLOW_ALL_CONTACTS === 'true';
const DAY = 86400000;
const ffmpeg = process.env.OPENAI_API_KEY && spawnSync(env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
const PAUSE_MS = bounded(env.HUMAN_PAUSE_MS, 3600000, 1000, 7 * DAY);
const pauseFile = env.PAUSE_STATE_PATH;
const pauseSecret = env.CONVERSATION_ADMIN_TOKEN || env.META_APP_SECRET || env.INSTAGRAM_APP_SECRET || env.ZAPCLAW_SECRET;
if (pauseFile && !pauseSecret) throw new Error('pause_state_requires_secret');
const pauses = new Map();
let pauseStorageHealthy = true;
if (pauseFile) {
  try {
    for (const [key, expiry] of JSON.parse(readFileSync(pauseFile, 'utf8'))) {
      if (expiry === 0 || expiry > Date.now()) pauses.set(key, expiry === 0 ? Infinity : expiry);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('pause_state_unreadable');
    savePauses();
  }
}
const botMessages = new Map();
const instagramSends = new Map();
const audioHints = new Map();
const waitingNotifications = new Map();

function bounded(value, fallback, min, max) {
  const number = Number(value || fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

const API = env.ZAPCLAW_API_BASE || 'https://api.zapclaw.app/api/v1';
const API_KEY = env.ZAPCLAW_API_KEY || '';
const WEBHOOK_SECRET = env.ZAPCLAW_SECRET || '';

const TYPEBOT_API = env.TYPEBOT_API || 'https://typebot.co/api';
const TYPEBOT_ID = env.TYPEBOT_PUBLIC_ID || 'assistente-felipe-f1w96o8';

const TEST_PHONE = digits(env.TEST_PHONE);
const ALLOW_ALL = env.ALLOW_ALL_CONTACTS === 'true';

const DEBOUNCE_MS = bounded(env.DEBOUNCE_MS, 10000, 5000, 45000);

const SEND_DELAY_MS = Math.min(
  8000,
  Math.max(0, Number(env.SEND_DELAY_MS || 2500))
);

const HANDOFF_ENABLED = env.HANDOFF_ENABLED === 'true';
const HANDOFF_SECRET = env.HANDOFF_SECRET || '';
const CLINIC_PHONE = digits(env.CLINIC_PHONE || '5521970617018');
const PERSONAL_PHONE = digits(env.PERSONAL_PHONE);
const HANDOFF_TEST_TO = digits(env.HANDOFF_TEST_TO);
const NOTIFICATION_DRY_RUN = env.NOTIFICATION_DRY_RUN !== 'false';

const destinations = {
  commercial: digits(env.COMMERCIAL_HANDOFF_PHONE) || CLINIC_PHONE,
  support: digits(env.SUPPORT_HANDOFF_PHONE) || PERSONAL_PHONE,
  finance: digits(env.FINANCE_HANDOFF_PHONE),
};
const notificationPhones = [...Object.values(destinations), CLINIC_PHONE, PERSONAL_PHONE, HANDOFF_TEST_TO,
  digits(env.HANDOFF_ALTERNATE_PHONE)].filter(Boolean);

const sessions = new Map();
const pending = new Map();
const processing = new Map();
const recentMessageIds = new Map();
const recentHandoffs = new Map();
const lastIncoming = new Map();

function digits(x) {
  return String(x || '').replace(/\D/g, '');
}

function comparePhone(x) {
  const n = digits(x);
  return n.length === 13 &&
    n.startsWith('55') &&
    n[4] === '9'
    ? n.slice(0, 4) + n.slice(5)
    : n;
}

function equalPhone(a, b) {
  return !!a && !!b && comparePhone(a) === comparePhone(b);
}

function secretMatches(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(raw, header, secret) {
  if (!secret) return false;
  const digest = createHmac('sha256', secret)
    .update(raw)
    .digest('hex');

  return secretMatches(header, `sha256=${digest}`);
}

function normalizeText(s) {
  return String(s || '').trim().slice(0, 16000);
}

function formatWhatsapp(s) {
  return normalizeText(s)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

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
  const response = await fetch(
    `${TYPEBOT_API}/v1/${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        textBubbleContentFormat: 'markdown',
      }),
      signal: AbortSignal.timeout(35000),
    }
  );

  if (!response.ok) {
    log('typebot_request_failed', { status: response.status });
    throw new Error(`typebot_${response.status}`);
  }

  return response.json();
}

function idempotencyKey(id) {
  const h = createHash('sha256')
    .update(String(id))
    .digest('hex');

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function sendText(from, to, text, uniqueId, template = '') {
  if (PROVIDER === 'meta') {
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
      throw new Error('missing_meta_credentials');
    }

    const content = template
      ? { type: 'template', template: { name: template, language: { code: env.HANDOFF_TEMPLATE_LANGUAGE || 'pt_BR' } } }
      : { type: 'text', text: { preview_url: false, body: normalizeText(text).slice(0, 4096) } };
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: digits(to),
          ...content,
        }),
        signal: AbortSignal.timeout(25000),
      }
    );

    const body = await response.json().catch(() => ({}));
    const accepted = response.ok && !!body.messages?.[0]?.id;

    if (accepted) rememberOnce(botMessages, body.messages[0].id, DAY);
    log('meta_send_result', { channel: 'whatsapp', status: response.status, accepted });

    return {
      ok: accepted,
      status: response.status,
      delivery: accepted ? idempotencyKey(body.messages[0].id) : undefined,
    };
  }

  if (PROVIDER !== 'zapclaw') {
    throw new Error('invalid_provider');
  }

  if (!API_KEY) {
    throw new Error('missing_zapclaw_api_key');
  }

  const response = await fetch(`${API}/send/text`, {
    method: 'POST',
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(uniqueId),
    },
    body: JSON.stringify({
      from,
      to,
      text: normalizeText(text).slice(0, 4096),
    }),
    signal: AbortSignal.timeout(25000),
  });

  if (response.status === 201) {
    return { ok: true };
  }

  if (response.status === 202) {
    return {
      ok: false,
      indeterminate: true,
      status: 202,
    };
  }

  return {
    ok: false,
    status: response.status,
  };
}

function rememberOnce(map, key, ttlMs) {
  const now = Date.now();

  if (map.get(key) > now) return false;

  map.set(key, now + ttlMs);
  return true;
}

function conversationKey(channel, account, sender) {
  return [channel, account, channel === 'whatsapp' ? comparePhone(sender) : sender].join(':');
}

function pauseKey(key) {
  return pauseSecret ? createHmac('sha256', pauseSecret).update(key).digest('hex') : key;
}

function savePauses() {
  if (!pauseFile) return true;
  try {
    const temp = pauseFile + '.new';
    const values = [...pauses].map(([key, until]) => [key, until === Infinity ? 0 : until]);
    writeFileSync(temp, JSON.stringify(values), { mode: 0o600 });
    renameSync(temp, pauseFile);
    pauseStorageHealthy = true;
  } catch {
    pauseStorageHealthy = false;
    log('pause_storage_error');
  }
  return pauseStorageHealthy;
}

function isPaused(key) {
  if (!pauseStorageHealthy) return true;
  const id = pauseKey(key);
  const until = pauses.get(id);
  if (until > Date.now()) return true;
  pauses.delete(id);
  return false;
}

function pause(key, duration = PAUSE_MS) {
  const active = processing.get(key);
  if (active) active.cancelled = true;
  const id = pauseKey(key);
  pauses.set(id, Math.max(pauses.get(id) || 0, duration === 0 ? Infinity : Date.now() + duration));
  savePauses();
  const queued = pending.get(key);
  if (queued) {
    clearTimeout(queued.timer);
    pending.delete(key);
  }
  log('conversation_paused', { channel: key.split(':')[0], conversation: idempotencyKey(key) });
}

function safeTimestamp(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 60000
    ? Math.min(timestamp, Date.now()) : 0;
}

function withinWindow(timestamp) {
  return timestamp > 0 && Date.now() - timestamp < DAY;
}

async function instagram(path, body) {
  const response = await fetch(IG_GRAPH + '/' + path, {
    headers: { Authorization: 'Bearer ' + IG_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    log('instagram_request_failed', { channel: 'instagram', status: response.status });
    throw new Error('instagram_request_failed');
  }
  return response.json();
}

function sendInstagram(to, text, key) {
  const send = (async () => {
    const result = await instagram(encodeURIComponent(IG_ID) + '/messages', {
      recipient: { id: to }, message: { text: text.slice(0, 1000) },
    });
    if (result.message_id) rememberOnce(botMessages, result.message_id, DAY);
    return { ok: !!result.message_id, delivery: result.message_id ? idempotencyKey(result.message_id) : undefined };
  })();
  instagramSends.set(key, send);
  return send.finally(() => instagramSends.delete(key));
}

async function collectBatch(items, context, canSend) {
  const blocks = [];
  let failedMedia = false;
  let hasAudio = false;
  for (const { data } of items) {
    const text = normalizeText(data.text?.body);
    if (data.story) blocks.push('[Resposta a story]');
    if (text) blocks.push(text);
    for (const media of data.media || []) {
      if (!canSend()) return { blocks, failedMedia, hasAudio };
      const start = Date.now();
      log('media_started', { ...context, type: media.type });
      try {
        const detail = await interpretMedia(media, WA_GRAPH, META_ACCESS_TOKEN);
        blocks.push((media.type === 'audio' ? '[Transcrição de áudio]\n' : '[Descrição de imagem]\n') + detail);
        hasAudio ||= media.type === 'audio';
        log('media_completed', { ...context, type: media.type, latencyMs: Date.now() - start });
      } catch {
        failedMedia = true;
        blocks.push(media.type === 'audio' ? '[Falha ao transcrever áudio]' : '[Falha ao interpretar imagem]');
        log('media_failed', { ...context, type: media.type, latencyMs: Date.now() - start });
      }
    }
  }
  return { blocks, failedMedia, hasAudio };
}

async function processConversation(key, items, active) {
  const { channel, data, account } = items.at(-1);
  const to = data.from;
  const from = digits(account.display_phone_number) || digits(env.WHATSAPP_FROM);
  const context = { channel, correlation: idempotencyKey(key + '/' + items.map(x => x.data.message_id).join('/')) };
  log('batch_processing', { ...context, events: items.map(item => idempotencyKey(item.data.message_id)) });
  const requiresWindow = channel === 'instagram' || PROVIDER === 'meta';
  const canSend = () => !active.cancelled && !isPaused(key) && (!requiresWindow || withinWindow(lastIncoming.get(key)));
  if (!canSend()) return;
  if (channel === 'whatsapp' && (!from || (PROVIDER === 'meta' ? !META_ACCESS_TOKEN : !API_KEY))) return;

  const started = Date.now();
  try {
    const { blocks, failedMedia, hasAudio } = await collectBatch(items, context, canSend);
    if (!canSend()) return;
    const allText = blocks.join('\n');
    if (!allText) return;
    let previous = sessions.get(key);
    if (previous?.until <= Date.now()) {
      sessions.delete(key);
      previous = undefined;
    }
    let reply;
    if (previous) {
      const choice = previous.choices.find((text, index) =>
        allText === String(index + 1) || allText.toLowerCase() === text.toLowerCase());
      try {
        reply = await typebot('sessions/' + encodeURIComponent(previous.id) + '/continueChat', {
          message: { type: 'text', text: choice || allText },
        });
      } catch (error) {
        if (error.message !== 'typebot_404') throw error;
        previous = undefined;
      }
    }

    let name = items.findLast(item => item.data.contact_name)?.data.contact_name || previous?.name || '';
    let username = previous?.username || '';
    if (!reply) {
      if (channel === 'instagram') {
        const profile = await instagram(encodeURIComponent(to) + '?fields=name,username').catch(() => ({}));
        name = profile.name || profile.username || '';
        username = profile.username || '';
      }
      if (!canSend()) return;
      reply = await typebot('typebots/' + encodeURIComponent(TYPEBOT_ID) + '/startChat', {
        message: { type: 'text', text: allText },
        prefilledVariables: {
          name, phone: channel === 'whatsapp' ? to : '', channel, username,
          contactId: to, professionalWhatsapp: 'https://wa.me/5521982995951',
        },
      });
    }
    log('typebot_processed', { ...context, latencyMs: Date.now() - started });

    const choices = reply.input?.type === 'choice input'
      ? (reply.input.items || []).map(item => item.content).filter(x => typeof x === 'string' && x)
      : [];
    const sessionId = reply.sessionId || previous?.id;
    if (!canSend()) return;
    if (reply.input && sessionId) sessions.set(key, { id: sessionId, choices, name, username, until: Date.now() + DAY });
    else sessions.delete(key);

    const bubbles = (reply.messages || []).filter(m => m.type === 'text' && typeof m.content?.markdown === 'string')
      .map(m => m.content.markdown);
    const required = channel === 'instagram' || env.TYPEBOT_REQUIRE_CONTROL === 'true';
    const { messages, control, suppressed } = typebotControls(bubbles, required);
    if (suppressed) return;
    if (control) log('typebot_decision', { ...context, classification: control.category, action: control.action });
    if (!canSend()) return;
    if (control?.action === 'pause') pause(key, 0);
    if (control?.action === 'handoff') {
      const result = await notify({ from, to, channel, name, username, control, context });
      log('handoff_result', { ...context, route: control.route, result });
      if (!['accepted', 'dry_run', 'queued'].includes(result)) return;
    }
    if (choices.length && (control?.action === 'reply' || !required)) {
      messages.push(choices.map((x, i) => (i + 1) + '. ' + x).join('\n'));
    }
    if (failedMedia && (messages.length || !required)) {
      messages.push('Parte da mídia não pôde ser lida. Pode enviar essa parte por escrito?');
    }
    const addAudioHint = messages.length && hasAudio && !(audioHints.get(key) > Date.now());
    if (addAudioHint) messages.push('Se puder, envie as próximas dúvidas por escrito.');
    if (SEND_DELAY_MS && messages.length) await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
    for (const [index, message] of messages.entries()) {
      if (!canSend()) break;
      const result = channel === 'instagram'
        ? await sendInstagram(to, message, key)
        : await sendText(from, to, formatWhatsapp(message), context.correlation + '/' + index);
      log('reply_result', { ...context, accepted: result.ok, index, delivery: result.delivery });
      if (!result.ok) break;
      if (addAudioHint && index === messages.length - 1) rememberOnce(audioHints, key, 7 * DAY);
    }
  } catch (error) {
    log('conversation_error', { ...context, type: error.name, latencyMs: Date.now() - started });
  }
}

function enqueueIncoming(event) {
  const { data, account } = event;
  const channel = event.channel || 'whatsapp';
  event.channel = channel;
  const sender = channel === 'instagram' ? data.from : digits(data.from);
  if (!sender || !account?.phone_number_id || !data.message_id) return;
  if (channel === 'instagram') {
    if (!IG_ALLOW_ALL && !IG_TEST_USERS.has(sender)) return;
  } else if ((!ALLOW_ALL && !equalPhone(TEST_PHONE, sender)) ||
      equalPhone(sender, account.display_phone_number) ||
      notificationPhones.some(phone => equalPhone(phone, sender))) {
    return;
  }
  const key = conversationKey(channel, account.phone_number_id, sender);
  if (!rememberOnce(recentMessageIds, key + ':' + data.message_id, DAY)) return;
  if (isPaused(key) || (!normalizeText(data.text?.body) && !data.media?.length)) return;
  let entry = pending.get(key);
  if (!entry) {
    entry = { items: [], timer: null };
    pending.set(key, entry);
  }
  entry.items.push(event);
  clearTimeout(entry.timer);
  log('message_queued', { channel, correlation: idempotencyKey(data.message_id), type: data.type, count: entry.items.length });
  entry.timer = setTimeout(() => flush(key, entry), DEBOUNCE_MS);
}

function flush(key, entry) {
  entry.timer = null;
  if (processing.has(key) || pending.get(key) !== entry) return;
  pending.delete(key);
  const items = entry.items.sort((a, b) => (a.data.timestamp || 0) - (b.data.timestamp || 0));
  const active = { cancelled: false };
  processing.set(key, active);
  void processConversation(key, items, active).finally(() => {
    processing.delete(key);
    const waiting = pending.get(key);
    if (waiting && !waiting.timer) flush(key, waiting);
  });
}

function safeLine(s, max = 350) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function buildHandoffMessage(p, kind) {
  const name = safeLine(p.name, 90) || 'Nao informado';
  const phone = digits(p.phone) || 'Nao informado';

  if (kind === 'lead') {
    return [
      'LEAD PARA CLINICA NEXUS',
      `Nome: ${name}`,
      `Telefone: ${phone}`,
      `Objetivo: ${safeLine(p.goal)}`,
      `Dificuldades: ${safeLine(p.difficulties)}`,
      `Servico de interesse: ${safeLine(p.service)}`,
      `Indicacao: ${safeLine(p.referral)}`,
      `Preferencia de dias/horarios: ${safeLine(p.availability)}`,
      `Objecoes: ${safeLine(p.objections)}`,
      `Status: ${safeLine(p.status || 'interesse confirmado')}`,
      `Observacoes comerciais: ${safeLine(p.notes, 500)}`,
    ].join('\n');
  }

  return [
    'SOLICITACAO DE SUPORTE',
    `Paciente: ${name}`,
    `Telefone: ${phone}`,
    `Categoria: ${safeLine(p.category)}`,
    `Acao solicitada: ${safeLine(p.action, 250)}`,
    'Consultar detalhes diretamente com o paciente.',
  ].join('\n');
}

function handoffDestination(route, from) {
  const destination = HANDOFF_TEST_TO || destinations[route];
  return equalPhone(from, destination) ? digits(env.HANDOFF_ALTERNATE_PHONE) : destination;
}

function notificationWindow(to) {
  return withinWindow(lastIncoming.get(conversationKey('whatsapp', META_PHONE_NUMBER_ID, to)));
}

async function notify({ from, to, channel, name, username, control, context }) {
  if (!HANDOFF_ENABLED) return 'disabled';
  from = digits(env.WHATSAPP_FROM) || from;
  const destination = handoffDestination(control.route, from);
  if (!from || !destination || equalPhone(from, destination) || equalPhone(to, destination)) return 'invalid_destination';
  if (NOTIFICATION_DRY_RUN) return 'dry_run';
  const testMode = !ALLOW_ALL || (channel === 'instagram' && !IG_ALLOW_ALL);
  if (testMode && !equalPhone(destination, HANDOFF_TEST_TO)) return 'test_destination_required';
  const contact = channel === 'whatsapp' ? 'https://wa.me/' + digits(to) :
    (/^[A-Za-z0-9_.]{1,30}$/.test(username) ? 'https://www.instagram.com/' + username + '/' : 'Localizar na caixa de entrada do Instagram');
  const details = control.items.map((item, index) => [
    'Demanda ' + (index + 1),
    ...Object.entries(supportFields).map(([field, label]) => label + ': ' + (safeLine(item[field], 350) || 'Não informado')),
  ].join('\n'));
  const heading = control.route === 'support' ? 'SUPORTE PENDENTE' : control.route === 'finance' ? 'FINANCEIRO PENDENTE' : 'COMERCIAL PENDENTE';
  const key = 'handoff/' + context.correlation;
  if (!rememberOnce(recentHandoffs, key, DAY)) return 'duplicate';
  const messages = details.map(detail => [
    heading + ' — ' + control.category.toUpperCase(), 'Aluno: ' + (safeLine(name, 90) || 'Não informado'),
    'Canal de origem: ' + channel, 'Link para contato: ' + contact, detail,
  ].join('\n'));
  if (PROVIDER === 'meta' && !notificationWindow(destination)) {
    if (!env.HANDOFF_TEMPLATE_NAME) return 'template_required';
    const destinationKey = comparePhone(destination);
    const queue = waitingNotifications.get(destinationKey) || [];
    if (queue.length >= 20) return 'queue_full';
    const notification = { from, key, messages, expires: Date.now() + DAY, next: 0 };
    queue.push(notification);
    waitingNotifications.set(destinationKey, queue);
    if (queue.length === 1) {
      const result = await sendText(from, destination, '', key, env.HANDOFF_TEMPLATE_NAME);
      if (!result.ok) return 'template_failed';
    }
    return 'queued';
  }
  return await deliverNotification(destination, { from, key, messages, next: 0 }) ? 'accepted' : 'failed';
}

async function deliverNotification(destination, notification) {
  while (notification.next < notification.messages.length) {
    if (PROVIDER === 'meta' && !notificationWindow(destination)) return false;
    const index = notification.next;
    const result = await sendText(notification.from, destination, notification.messages[index], notification.key + '/' + index);
    if (!result.ok) return false;
    notification.next++;
  }
  return true;
}

const notificationFlushes = new Set();
async function flushNotifications(destination) {
  const key = comparePhone(destination);
  const queue = waitingNotifications.get(key);
  if (!queue?.length || notificationFlushes.has(key)) return;
  notificationFlushes.add(key);
  try {
    while (queue.length) {
      const notification = queue[0];
      if (notification.expires > Date.now()) {
        if (!await deliverNotification(destination, notification)) break;
        log('handoff_delivered', { channel: 'whatsapp', correlation: notification.key });
      }
      queue.shift();
    }
    if (!queue.length) waitingNotifications.delete(key);
  } catch {
    log('handoff_delivery_error', { channel: 'whatsapp' });
  } finally {
    notificationFlushes.delete(key);
  }
}

async function handleHandoff(req, res) {
  if (
    !HANDOFF_SECRET ||
    !secretMatches(req.headers['x-relay-token'], HANDOFF_SECRET)
  ) {
    return json(res, 401, {
      ok: false,
      error: 'unauthorized',
    });
  }

  if (!HANDOFF_ENABLED) {
    return json(res, 403, {
      ok: false,
      error: 'handoffs_disabled',
    });
  }

  let p;

  try {
    p = JSON.parse(
      (await readBody(req, 25000)).toString('utf8')
    );
  } catch {
    return json(res, 400, {
      ok: false,
      error: 'invalid_json',
    });
  }

  if (!p || typeof p !== 'object' || Array.isArray(p)) return json(res, 400, { ok: false });
  const kind = p.kind;

  if (!['lead', 'followup', 'support'].includes(kind)) {
    return json(res, 400, {
      ok: false,
      error: 'invalid_kind',
    });
  }

  if (!p.requestId || !p.name || !p.phone) {
    return json(res, 400, {
      ok: false,
      error: 'missing_required_fields',
    });
  }

  if (
    (kind === 'support' || kind === 'lead') &&
    p.confirmed !== true
  ) {
    return json(res, 400, {
      ok: false,
      error: 'not_confirmed',
    });
  }

  if (kind === 'followup' && p.optInFollowup !== true) {
    return json(res, 400, {
      ok: false,
      error: 'followup_without_optin',
    });
  }

  const from = digits(env.WHATSAPP_FROM);

  if (!from) {
    return json(res, 500, {
      ok: false,
      error: 'WHATSAPP_FROM_missing',
    });
  }

  const to = handoffDestination(kind === 'support' ? 'support' : 'commercial', from);

  if (!to) {
    return json(res, 422, {
      ok: false,
      error: 'destination_missing',
    });
  }

  if (equalPhone(from, to)) {
    return json(res, 422, {
      ok: false,
      error: 'cannot_send_to_same_number',
    });
  }

  if (!ALLOW_ALL && !NOTIFICATION_DRY_RUN && !equalPhone(to, HANDOFF_TEST_TO)) {
    return json(res, 403, {
      ok: false,
      error: 'test_destination_required',
    });
  }

  const msg = buildHandoffMessage(
    {
      ...p,
      status: kind === 'followup'
        ? 'Lead para follow-up (contato autorizado)'
        : p.status,
    },
    kind === 'followup' ? 'lead' : kind
  );

  const key = `${kind}:${digits(p.phone)}:${safeLine(p.requestId, 120)}`;

  if (NOTIFICATION_DRY_RUN) {
    return json(res, 200, {
      ok: true,
      dryRun: true,
      destinationMasked: `***${to.slice(-4)}`,
      kind,
      summaryLength: msg.length,
    });
  }

  if (PROVIDER === 'meta') {
    if (!notificationWindow(to)) {
      return json(res, 422, {
        ok: false,
        error: 'meta_approved_template_required',
      });
    }
  }

  if (!rememberOnce(recentHandoffs, key, 24 * 60 * 60 * 1000)) {
    return json(res, 200, {
      ok: true,
      duplicate: true,
    });
  }

  const result = await sendText(
    from,
    to,
    msg,
    `handoff/${key}`
  );

  if (result.ok) {
    return json(res, 201, {
      ok: true,
      accepted: true,
      kind,
    });
  }

  return json(res, result.indeterminate ? 202 : 502, {
    ok: false,
    status: result.status,
    indeterminate: !!result.indeterminate,
    error: 'delivery_not_confirmed',
  });
}

async function handleMetaWebhook(req, res, channel) {
  const url = new URL(req.url, 'http://localhost');
  const instagramChannel = channel === 'instagram';
  const verifyToken = instagramChannel ? (env.INSTAGRAM_VERIFY_TOKEN || META_VERIFY_TOKEN) : META_VERIFY_TOKEN;
  const appSecret = instagramChannel ? (env.INSTAGRAM_APP_SECRET || META_APP_SECRET) : META_APP_SECRET;

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (
      verifyToken &&
      mode === 'subscribe' &&
      challenge !== null &&
      secretMatches(token, verifyToken)
    ) {
      log('webhook_verified', { channel });

      res.writeHead(200, {
        'Content-Type': 'text/plain',
      });

      return res.end(challenge);
    }

    return json(res, 403, { ok: false });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false });
  }

  let raw;

  try {
    raw = await readBody(req, 1024 * 1024);
  } catch {
    return json(res, 413, { ok: false });
  }

  if (!appSecret) {
    return json(res, 503, {
      ok: false,
      error: 'missing_meta_app_secret',
    });
  }

  if (
    !verifySignature(
      raw,
      req.headers['x-hub-signature-256'],
      appSecret
    )
  ) {
    log('webhook_invalid_signature', { channel });

    return json(res, 401, {
      ok: false,
      error: 'invalid_signature',
    });
  }

  let payload;

  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(res, 400, {
      ok: false,
      error: 'invalid_json',
    });
  }

  json(res, 200, { ok: true });

  if (instagramChannel) {
    receiveInstagram(payload);
  } else if (PROVIDER === 'meta') {
    receiveWhatsApp(payload);
  }
}

function recordIncoming(key, timestamp) {
  if (timestamp) lastIncoming.set(key, Math.max(lastIncoming.get(key) || 0, timestamp));
}

function receiveWhatsApp(payload) {
  if (payload?.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const account = value.metadata || {};
      if (!META_PHONE_NUMBER_ID || String(account.phone_number_id) !== META_PHONE_NUMBER_ID) continue;
      const keyFor = sender => conversationKey('whatsapp', account.phone_number_id, sender);
      if (change.field === 'smb_message_echoes') {
        for (const echo of value.message_echoes || []) {
          if (!echo.id || !digits(echo.to) || botMessages.get(echo.id) > Date.now() ||
              !rememberOnce(recentMessageIds, 'wa-echo:' + echo.id, DAY)) continue;
          pause(keyFor(echo.to));
        }
        continue;
      }
      if (change.field !== 'messages') continue;
      for (const status of value.statuses || []) {
        log('delivery_status', { channel: 'whatsapp', correlation: idempotencyKey(status.id), status: status.status });
      }
      for (const message of value.messages || []) {
        const sender = digits(message.from);
        if (!sender || !message.id) continue;
        const timestamp = safeTimestamp(Number(message.timestamp) * 1000);
        recordIncoming(keyFor(sender), timestamp);
        if (message.type === 'text' && timestamp && notificationWindow(sender)) void flushNotifications(sender);
        log('message_received', { channel: 'whatsapp', correlation: idempotencyKey(message.id), type: message.type });
        if (!['text', 'audio', 'image', 'interactive', 'button'].includes(message.type)) continue;
        const attachment = ['audio', 'image'].includes(message.type) ? message[message.type] : undefined;
        const contact = (value.contacts || []).find(item => equalPhone(item.wa_id, sender));
        enqueueIncoming({
          account,
          data: {
            type: message.type, from: sender, message_id: message.id, timestamp,
            contact_name: contact?.profile?.name || '',
            text: { body: message.text?.body || attachment?.caption ||
              message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.button?.text },
            media: attachment?.id ? [{ type: message.type, id: attachment.id, mime: attachment.mime_type }] : [],
          },
        });
      }
    }
  }
}

function receiveInstagram(payload) {
  if (payload?.object !== 'instagram' || !IG_ID || !IG_TOKEN) return;
  for (const entry of payload.entry || []) {
    if (String(entry.id) !== IG_ID) continue;
    const events = [...(entry.messaging || []), ...(entry.changes || [])
      .filter(change => ['messages', 'messaging_seen', 'message_reactions'].includes(change.field))
      .map(change => change.value)];
    for (const event of events) {
      const sender = String(event?.sender?.id || '');
      const recipient = String(event?.recipient?.id || '');
      const message = event?.message;
      if (event?.read || event?.seen) {
        log('delivery_status', { channel: 'instagram', status: 'seen', correlation: idempotencyKey(event.read?.mid || event.seen?.mid) });
      }
      if (!message?.mid || message.is_deleted || message.is_unsupported) continue;
      if (sender === IG_ID && recipient !== IG_ID && /^\d+$/.test(recipient)) {
        const key = conversationKey('instagram', IG_ID, recipient);
        if (!rememberOnce(recentMessageIds, 'ig-echo:' + message.mid, DAY)) continue;
        const check = () => {
          if (!(botMessages.get(message.mid) > Date.now())) pause(key);
        };
        const inFlight = instagramSends.get(key);
        if (inFlight) void inFlight.then(check, check);
        else check();
        continue;
      }
      if (recipient !== IG_ID || sender === IG_ID || !/^\d+$/.test(sender) ||
          message.is_echo || message.is_self || message.is_self_reply || event.reaction) continue;
      if (!IG_ALLOW_ALL && !IG_TEST_USERS.has(sender)) continue;
      const media = (message.attachments || []).filter(item =>
        ['audio', 'image'].includes(item.type) && typeof item.payload?.url === 'string')
        .map(item => ({ type: item.type, url: item.payload.url }));
      const timestamp = safeTimestamp(Number(event.timestamp));
      recordIncoming(conversationKey('instagram', IG_ID, sender), timestamp);
      log('message_received', { channel: 'instagram', correlation: idempotencyKey(message.mid), type: message.reply_to?.story ? 'story_reply' : 'direct' });
      enqueueIncoming({
        channel: 'instagram',
        account: { phone_number_id: IG_ID },
        data: { type: media.length ? 'media' : 'text', from: sender, message_id: message.mid,
          timestamp, text: { body: message.text }, media, story: !!message.reply_to?.story },
      });
    }
  }
}

async function handlePause(req, res) {
  if (!env.CONVERSATION_ADMIN_TOKEN ||
      !secretMatches(req.headers['x-relay-token'], env.CONVERSATION_ADMIN_TOKEN)) {
    return json(res, 401, { ok: false });
  }
  let data;
  try {
    data = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return json(res, 400, { ok: false });
  }
  const { channel, contact, action, durationMs, accountId } = data || {};
  const account = channel === 'instagram' ? IG_ID : META_PHONE_NUMBER_ID || accountId;
  if (!['instagram', 'whatsapp'].includes(channel) || !account || !/^\d+$/.test(String(contact)) ||
      !['pause', 'resume'].includes(action) ||
      (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7 * DAY))) {
    return json(res, 400, { ok: false });
  }
  const key = conversationKey(channel, account, String(contact));
  if (action === 'resume') {
    const active = processing.get(key);
    if (active) active.cancelled = true;
    const id = pauseKey(key);
    const previous = pauses.get(id);
    pauses.delete(id);
    if (!savePauses() && previous) pauses.set(id, previous);
    sessions.delete(key);
    log('conversation_resumed', { channel, conversation: idempotencyKey(key) });
  } else {
    pause(key, durationMs);
  }
  if (!pauseStorageHealthy) return json(res, 503, { ok: false, error: 'pause_storage_error' });
  return json(res, 200, { ok: true, paused: isPaused(key) });
}

// Expire in-memory identifiers and sessions even when a contact never returns.
setInterval(() => {
  const now = Date.now();
  for (const map of [recentMessageIds, recentHandoffs, botMessages, audioHints, pauses]) {
    for (const [key, expires] of map) if (expires <= now) map.delete(key);
  }
  for (const [key, timestamp] of lastIncoming) if (!withinWindow(timestamp)) lastIncoming.delete(key);
  for (const [key, queue] of waitingNotifications) {
    if (notificationFlushes.has(key)) continue;
    while (queue[0]?.expires <= now) queue.shift();
    if (!queue.length) waitingNotifications.delete(key);
  }
  for (const [key, session] of sessions) if (session.until <= now) sessions.delete(key);
}, 60000).unref();

export const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(
      req.url,
      'http://localhost'
    ).pathname;

    if (req.method === 'GET' && pathname === '/') {
      return json(res, 200, {
        service: 'relay',
        version: 4,
        integrations: {
          whatsapp: PROVIDER === 'meta' ? !!(META_ACCESS_TOKEN && META_PHONE_NUMBER_ID && META_APP_SECRET && META_VERIFY_TOKEN) : !!(API_KEY && WEBHOOK_SECRET),
          instagram: !!(IG_TOKEN && IG_ID && (env.INSTAGRAM_APP_SECRET || META_APP_SECRET) && (env.INSTAGRAM_VERIFY_TOKEN || META_VERIFY_TOKEN)),
          instagramTestOnly: !IG_ALLOW_ALL,
          typebot: !!(TYPEBOT_API && TYPEBOT_ID),
          media: !!env.OPENAI_API_KEY,
          ffmpeg: !!ffmpeg,
          pauseAdmin: !!env.CONVERSATION_ADMIN_TOKEN,
          pausePersistence: !!pauseFile && pauseStorageHealthy,
        },
        provider: PROVIDER,
        testOnly: !ALLOW_ALL,
        testPhoneConfigured: !!TEST_PHONE,
        debounceMs: DEBOUNCE_MS,
        handoffsEnabled: HANDOFF_ENABLED,
        notificationDryRun: NOTIFICATION_DRY_RUN,
        metaConfigured: !!(
          META_ACCESS_TOKEN &&
          META_PHONE_NUMBER_ID &&
          META_VERIFY_TOKEN &&
          META_APP_SECRET
        ),
      });
    }

    if (pathname === '/webhook/meta' || pathname === '/webhook/instagram') {
      return await handleMetaWebhook(req, res, pathname.endsWith('/instagram') ? 'instagram' : 'whatsapp');
    }

    if (req.method === 'POST' && pathname === '/admin/conversation') {
      return await handlePause(req, res);
    }

    if (req.method === 'POST' && pathname === '/handoff') {
      return await handleHandoff(req, res);
    }

    if (req.method !== 'POST' || pathname !== '/webhook') {
      return json(res, 404, { ok: false });
    }

    if (PROVIDER !== 'zapclaw') {
      return json(res, 200, {
        ok: true,
        ignored: true,
      });
    }

    let raw;

    try {
      raw = await readBody(req, 1024 * 1024);
    } catch {
      return json(res, 413, { ok: false });
    }

    if (
      !verifySignature(
        raw,
        req.headers['x-zapclaw-signature'],
        WEBHOOK_SECRET
      )
    ) {
      return json(res, 401, {
        ok: false,
        error: 'invalid_signature',
      });
    }

    let event;

    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, { ok: false });
    }

    json(res, 200, { ok: true });

    if (
      event.event === 'message.received' &&
      event.data?.type === 'text' &&
      event.account
    ) {
      enqueueIncoming(event);
    }
  } catch (err) {
    log('server_error', { type: err.name });

    if (!res.headersSent) {
      return json(res, 500, { ok: false });
    }

    if (!res.writableEnded) res.end();
  }
}).listen(PORT, '0.0.0.0', () => {
  log('relay_v4_ready', {
    provider: PROVIDER,
    testOnly: !ALLOW_ALL,
    debounceMs: DEBOUNCE_MS,
    handoffsEnabled: HANDOFF_ENABLED,
    notificationDryRun: NOTIFICATION_DRY_RUN,
  });
});
