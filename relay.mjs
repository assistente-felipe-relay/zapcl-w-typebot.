
// WhatsApp Meta Cloud API + ZapClaw + Typebot
// Relay V3 | Node.js 20+

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

const API = env.ZAPCLAW_API_BASE || 'https://api.zapclaw.app/api/v1';
const API_KEY = env.ZAPCLAW_API_KEY || '';
const WEBHOOK_SECRET = env.ZAPCLAW_SECRET || '';

const TYPEBOT_API = env.TYPEBOT_API || 'https://typebot.co/api';
const TYPEBOT_ID = env.TYPEBOT_PUBLIC_ID || 'assistente-felipe-f1w96o8';

const TEST_PHONE = digits(env.TEST_PHONE);
const ALLOW_ALL = env.ALLOW_ALL_CONTACTS === 'true';

const DEBOUNCE_MS = Math.min(
  45000,
  Math.max(5000, Number(env.DEBOUNCE_MS || 30000))
);

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

const SILENCE_TOKEN = '[[SEM_RESPOSTA]]';

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
    throw new Error(`typebot_${response.status}`);
  }

  console.log('typebot_success');

  return response.json();
}

function idempotencyKey(id) {
  const h = createHash('sha256')
    .update(String(id))
    .digest('hex');

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function sendText(from, to, text, uniqueId) {
  if (PROVIDER === 'meta') {
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
      throw new Error('missing_meta_credentials');
    }

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
          type: 'text',
          text: {
            preview_url: false,
            body: normalizeText(text).slice(0, 4096),
          },
        }),
        signal: AbortSignal.timeout(25000),
      }
    );

    const body = await response.json().catch(() => ({}));
    const accepted = response.ok && !!body.messages?.[0]?.id;

    console.log('meta_send_result', {
      status: response.status,
      accepted,
      errorCode: body.error?.code,
      errorSubcode: body.error?.error_subcode,
    });

    return {
      ok: accepted,
      status: response.status,
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

  for (const [item, until] of map) {
    if (until < now) map.delete(item);
  }

  if (map.has(key)) return false;

  map.set(key, now + ttlMs);
  return true;
}

async function processConversation(key, batch) {
  const { event, texts, seq, ids } = batch;
  const { data, account } = event;

  const to = data.from || data.user_id;
  const from = digits(account?.display_phone_number);

  if (!from || !to) return;
  if (PROVIDER === 'meta' && !META_ACCESS_TOKEN) return;
  if (PROVIDER === 'zapclaw' && !API_KEY) return;

  console.log('conversation_processing', {
    provider: PROVIDER,
    messageCount: texts.length,
  });

  const allText = texts.join('\n');
  const previous = sessions.get(key);

  let reply;

  try {
    if (previous) {
      const choice = (previous.choices || []).find(
        (x, i) =>
          allText === String(i + 1) ||
          allText.toLowerCase() === x.toLowerCase()
      );

      try {
        reply = await typebot(
          `sessions/${encodeURIComponent(previous.id)}/continueChat`,
          {
            message: {
              type: 'text',
              text: choice || allText,
            },
          }
        );
      } catch (err) {
        if (err.message !== 'typebot_404') throw err;
      }
    }

    if (!reply) {
      reply = await typebot(
        `typebots/${encodeURIComponent(TYPEBOT_ID)}/startChat`,
        {
          message: {
            type: 'text',
            text: allText,
          },
          prefilledVariables: {
            name: data.contact_name || '',
            phone: to,
          },
        }
      );
    }

    const choices = reply.input?.type === 'choice input'
      ? (reply.input.items || [])
          .map(item => item.content)
          .filter(x => typeof x === 'string' && x)
      : [];

    if (reply.input && (reply.sessionId || previous?.id)) {
      sessions.set(key, {
        id: reply.sessionId || previous.id,
        choices,
      });
    } else {
      sessions.delete(key);
    }

    let messages = (reply.messages || [])
      .filter(
        m => m.type === 'text' &&
        typeof m.content?.markdown === 'string'
      )
      .map(m => formatWhatsapp(m.content.markdown));

    if (choices.length) {
      messages.push(
        choices.map((x, i) => `${i + 1}. ${x}`).join('\n')
      );
    }

    messages = messages.filter(
      m => m && m.trim().toUpperCase() !== SILENCE_TOKEN
    );

    if (!messages.length) {
      console.log('typebot_no_reply');
      return;
    }

    if ((pending.get(key)?.seq || 0) > seq) {
      console.log('reply_superseded');
      return;
    }

    if (SEND_DELAY_MS) {
      await new Promise(
        r => setTimeout(r, SEND_DELAY_MS)
      );
    }

    for (let i = 0; i < messages.length; i++) {
      if ((pending.get(key)?.seq || 0) > seq) break;

      const result = await sendText(
        from,
        to,
        messages[i],
        `${key}/${ids.join('-')}/answer/${i}`
      );

      if (!result.ok) {
        console.error(
          'whatsapp_reply_failed',
          result.status || 'unknown'
        );
        break;
      }
    }
  } catch (err) {
    console.error('conversation_error', err.name);
  }
}

function enqueueIncoming(event) {
  const { data, account } = event;
  const sender = digits(data?.from);

  if (!sender || !account?.phone_number_id) return;

  if (!ALLOW_ALL && (!TEST_PHONE || !equalPhone(TEST_PHONE, sender))) {
    console.log('test_phone_filtered');
    return;
  }

  if (equalPhone(sender, account?.display_phone_number)) {
    return;
  }

  if (
    equalPhone(sender, CLINIC_PHONE) ||
    equalPhone(sender, PERSONAL_PHONE)
  ) {
    console.log('notification_destination_filtered');
    return;
  }

  const id = `${account.phone_number_id}:${data.message_id}`;

  if (
    !data.message_id ||
    !rememberOnce(recentMessageIds, id, 24 * 60 * 60 * 1000)
  ) {
    console.log('duplicate_message_filtered');
    return;
  }

  const key = `${account.phone_number_id}:${comparePhone(sender)}`;
  const text = normalizeText(data.text?.body);

  if (!text) return;

  let entry = pending.get(key);

  if (!entry) {
    entry = {
      texts: [],
      ids: [],
      seq: 0,
      timer: null,
      event,
    };
  }

  entry.texts.push(text);
  entry.ids.push(data.message_id);
  entry.event = event;
  entry.seq++;

  if (entry.timer) clearTimeout(entry.timer);

  const selectedSeq = entry.seq;

  console.log('message_queued', {
    count: entry.texts.length,
    debounceMs: DEBOUNCE_MS,
  });

  entry.timer = setTimeout(() => {
    const existing = pending.get(key);

    if (!existing || existing.seq !== selectedSeq) return;

    const batch = {
      event: existing.event,
      texts: existing.texts.splice(0),
      ids: existing.ids.splice(0),
      seq: selectedSeq,
    };

    existing.timer = null;

    const earlier = processing.get(key) || Promise.resolve();

    const run = earlier
      .catch(() => {})
      .then(() => processConversation(key, batch));

    processing.set(key, run);

    run.finally(() => {
      if (processing.get(key) === run) {
        processing.delete(key);

        const current = pending.get(key);

        if (
          current &&
          !current.timer &&
          !current.texts.length
        ) {
          pending.delete(key);
        }
      }
    });
  }, DEBOUNCE_MS);

  pending.set(key, entry);
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

  const to = HANDOFF_TEST_TO ||
    (kind === 'support' ? PERSONAL_PHONE : CLINIC_PHONE);

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

  if (!ALLOW_ALL && !NOTIFICATION_DRY_RUN && !HANDOFF_TEST_TO) {
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
    const last = lastIncoming.get(comparePhone(to));

    if (!last || Date.now() - last >= 24 * 60 * 60 * 1000) {
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

async function handleMetaWebhook(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (
      META_VERIFY_TOKEN &&
      mode === 'subscribe' &&
      challenge !== null &&
      secretMatches(token, META_VERIFY_TOKEN)
    ) {
      console.log('meta_webhook_verified');

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

  if (!META_APP_SECRET) {
    return json(res, 503, {
      ok: false,
      error: 'missing_meta_app_secret',
    });
  }

  if (
    !verifySignature(
      raw,
      req.headers['x-hub-signature-256'],
      META_APP_SECRET
    )
  ) {
    console.log('meta_invalid_signature');

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

  if (PROVIDER !== 'meta') return;
  if (payload.object !== 'whatsapp_business_account') return;

  console.log('meta_webhook_received');

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const metadata = value.metadata || {};

      if (
        String(metadata.phone_number_id) !==
        String(META_PHONE_NUMBER_ID)
      ) {
        console.log('meta_wrong_phone_id');
        continue;
      }

      for (const status of value.statuses || []) {
        console.log('meta_delivery_status', {
          status: status.status,
          errorCode: status.errors?.[0]?.code,
        });
      }

      for (const message of value.messages || []) {
        const sender = digits(message.from);

        if (!sender) continue;

        const receivedAt = Number(message.timestamp) * 1000;

        if (
          Number.isFinite(receivedAt) &&
          receivedAt > 0 &&
          receivedAt <= Date.now()
        ) {
          const phoneKey = comparePhone(sender);

          lastIncoming.set(
            phoneKey,
            Math.max(lastIncoming.get(phoneKey) || 0, receivedAt)
          );
        }

        if (message.type !== 'text') {
          console.log('meta_unsupported_message_type');
          continue;
        }

        const contact = (value.contacts || []).find(
          c => equalPhone(c.wa_id, sender)
        );

        console.log('meta_message_received');

        enqueueIncoming({
          event: 'message.received',
          account: {
            phone_number_id: metadata.phone_number_id,
            display_phone_number: metadata.display_phone_number,
          },
          data: {
            type: 'text',
            from: sender,
            user_id: sender,
            message_id: message.id,
            contact_name: contact?.profile?.name || '',
            text: {
              body: message.text?.body || '',
            },
          },
        });
      }
    }
  }
}

createServer(async (req, res) => {
  try {
    const pathname = new URL(
      req.url,
      'http://localhost'
    ).pathname;

    if (req.method === 'GET' && pathname === '/') {
      return json(res, 200, {
        service: 'relay',
        version: 3,
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

    if (pathname === '/webhook/meta') {
      return await handleMetaWebhook(req, res);
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
    console.error('server_error', err.name);

    if (!res.headersSent) {
      return json(res, 500, { ok: false });
    }

    if (!res.writableEnded) res.end();
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('relay_v3_ready', {
    provider: PROVIDER,
    testOnly: !ALLOW_ALL,
    debounceMs: DEBOUNCE_MS,
    handoffsEnabled: HANDOFF_ENABLED,
    notificationDryRun: NOTIFICATION_DRY_RUN,
  });
});
