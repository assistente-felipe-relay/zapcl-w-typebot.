import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { typebotControls } from '../controls.mjs';

const replyControl = '[[RELAY_V1]]{"category":"support","action":"reply"}';
const user = '5521999000001';
const account = '99';
const secret = 'fake-signing-secret';
const admin = 'fake-admin-secret';

test('Typebot preserva texto legado e bloqueia controle inválido, pessoal ou silencioso', () => {
  assert.deepEqual(typebotControls(['[Veja](https://example.com)'], false).messages, ['[Veja](https://example.com)']);
  assert.deepEqual(typebotControls(['Olá'], true).messages, []);
  assert.deepEqual(typebotControls(['Olá', '[[SEM_RESPOSTA]]'], false).messages, []);
  assert.deepEqual(typebotControls(['Olá', '[[RELAY_V1]]invalid'], false).messages, []);
  assert.deepEqual(typebotControls(['Olá', '[[RELAY_V1]]{"action":"reply","category":"personal"}'], true).messages, []);
  assert.deepEqual(typebotControls(['Olá', replyControl], true).messages, ['Olá']);
  assert.deepEqual(typebotControls(['Olá', '[[RELAY_V1]]{"action":"handoff","category":"support","route":"support","items":[{}]}'], true).messages, []);
});

test('webhooks simulados preservam WhatsApp e isolam sessões, mídia, duplicatas e pausa', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pauseFile = join(directory, 'pauses.json');
  Object.assign(process.env, {
    PAUSE_STATE_PATH: pauseFile, ALLOW_ALL_CONTACTS: 'false', INSTAGRAM_ALLOW_ALL_CONTACTS: 'false',
    WHATSAPP_PROVIDER: 'meta', TYPEBOT_REQUIRE_CONTROL: 'false',
    PORT: '0', DEBOUNCE_MS: '5000', SEND_DELAY_MS: '0', TEST_PHONE: user,
    META_ACCESS_TOKEN: 'fake-wa', META_APP_SECRET: secret, META_VERIFY_TOKEN: 'verification',
    META_PHONE_NUMBER_ID: account, INSTAGRAM_ACCOUNT_ID: '500', INSTAGRAM_ACCESS_TOKEN: 'fake-ig',
    INSTAGRAM_TEST_USERS: user + ',3333', OPENAI_API_KEY: 'fake-openai', CONVERSATION_ADMIN_TOKEN: admin,
    HANDOFF_ENABLED: 'true', HANDOFF_SECRET: 'fake-handoff', WHATSAPP_FROM: '5521999000000',
    HANDOFF_TEST_TO: '5521999000002', NOTIFICATION_DRY_RUN: 'true',
  });
  const calls = [];
  const localFetch = globalThis.fetch;
  let releaseTranscription;
  const transcription = new Promise(resolve => { releaseTranscription = resolve; });
  globalThis.fetch = async (url, options) => {
    const href = String(url);
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ href, body });
    if (href.includes('graph.facebook.com') && href.endsWith('/media-1')) {
      return Response.json({ url: 'https://lookaside.fbsbx.com/file', mime_type: 'audio/mpeg' });
    }
    if (href.includes('lookaside.fbsbx.com')) return new Response('mock media');
    if (href.endsWith('/audio/transcriptions')) {
      await transcription;
      return Response.json({ text: 'Preciso trocar o lanche e ajustar o horário.' });
    }
    if (href.includes('cdninstagram.com')) return new Response('mock image', { headers: { 'content-type': 'image/png' } });
    if (href.endsWith('/v1/responses')) return Response.json({
      output: [{ content: [{ type: 'output_text', text: 'Print de treino com dois exercícios.' }] }],
    });
    if (href.includes('graph.instagram.com') && href.includes('?fields=')) return Response.json({ name: 'Teste', username: 'tester' });
    if (href.includes('graph.instagram.com')) return Response.json({ message_id: 'ig-bot-1' });
    if (href.includes('graph.facebook.com')) return Response.json({ messages: [{ id: 'wa-bot-1' }] });
    if (href.includes('/startChat') || href.includes('/continueChat')) {
      const instagram = body.prefilledVariables?.channel === 'instagram' || href.includes('session-ig');
      const isHandoff = body.message.text === 'Encaminhar duas demandas';
      const control = isHandoff
        ? '[[RELAY_V1]]{"category":"support","action":"handoff","route":"support","items":[{"request":"Dúvida da refeição"},{"request":"Dúvida do treino"}]}'
        : replyControl;
      return Response.json({
        sessionId: instagram ? 'session-ig' : 'session-wa',
        input: { type: 'text input' },
        messages: [...(instagram ? [control] : []), isHandoff ? 'Resposta de encaminhamento' : 'Resposta de teste']
          .map(markdown => ({ type: 'text', content: { markdown } })),
      });
    }
    throw new Error('unexpected request');
  };
  const { server } = await import('../relay.mjs');
  t.after(() => {
    releaseTranscription();
    globalThis.fetch = localFetch;
    server.close();
  });
  if (!server.listening) await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;

  function post(path, payload, credentials = {}) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return localFetch(base + path, {
      method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + signature, ...credentials },
    });
  }
  function wa(messages) {
    return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: account, display_phone_number: '5521999000000' }, messages,
    } }] }] };
  }
  function ig(messaging) {
    return { object: 'instagram', entry: [{ id: '500', messaging }] };
  }
  const waText = (id, text, from = user, timestamp = Math.floor(Date.now() / 1000)) =>
    ({ id, from, timestamp, type: 'text', text: { body: text } });
  const igMessage = (mid, text, sender = user, recipient = '500', fields = {}) =>
    ({ sender: { id: sender }, recipient: { id: recipient }, timestamp: Date.now(), message: { mid, text, ...fields } });
  async function waitFor(predicate) {
    for (let i = 0; i < 250; i++) {
      const value = predicate();
      if (value) return value;
      await delay(40);
    }
    assert.fail('evento esperado não ocorreu');
  }

  const health = await localFetch(base + '/').then(res => res.json());
  assert.equal(health.integrations.instagram, true);
  assert.equal(health.integrations.pausePersistence, true);
  assert.equal((await localFetch(base + '/webhook/instagram?hub.mode=subscribe&hub.verify_token=verification&hub.challenge=123')).status, 200);
  assert.equal((await post('/webhook/meta', wa([]), { 'x-hub-signature-256': 'invalid' })).status, 401);
  assert.equal((await post('/admin/conversation', {}, { 'x-relay-token': 'wrong' })).status, 401);
  assert.equal((await post('/handoff', { kind: 'support', requestId: 'test', name: 'Teste', phone: user, confirmed: true },
    { 'x-relay-token': 'fake-handoff' }).then(res => res.json())).dryRun, true);
  const now = Math.floor(Date.now() / 1000);
  const audio = { id: 'audio', type: 'audio', from: user, timestamp: now, audio: { id: 'media-1' } };
  await post('/webhook/meta', wa([audio, waText('first', 'Primeiro texto', user, now - 1), audio, waText('blocked', 'Bloqueado', '5521999000099')]));
  await post('/webhook/instagram', ig([
    igMessage('story', 'Dúvida de treino?', user, '500', { reply_to: { story: { id: '1' } },
      attachments: [{ type: 'image', payload: { url: 'https://scontent.cdninstagram.com/print' } }] }),
    igMessage('ignored', 'Ignorado', '1234'),
  ]));
  await waitFor(() => calls.find(call => call.href.endsWith('/audio/transcriptions')));
  await post('/webhook/meta', wa([waText('later', 'Chegou durante a transcrição')]));
  releaseTranscription();
  const first = await waitFor(() => calls.find(call => call.body?.prefilledVariables?.channel === 'whatsapp'));
  assert.match(first.body.message.text, /^Primeiro texto\n.*\nPreciso trocar o lanche e ajustar o horário\.$/);
  const story = await waitFor(() => calls.find(call => call.body?.prefilledVariables?.channel === 'instagram'));
  assert.match(story.body.message.text, /Resposta a story[\s\S]*Print de treino/);
  assert.equal(story.body.prefilledVariables.phone, '');
  assert.equal(story.body.prefilledVariables.username, 'tester');
  await waitFor(() => calls.find(call => call.href.includes('graph.instagram.com') && call.body?.message?.text === 'Resposta de teste'));
  await post('/webhook/instagram', ig([igMessage('ig-bot-1', 'Resposta de teste', '500', user, { is_echo: true })]));
  await post('/webhook/instagram', ig([igMessage('after-echo', 'Outra dúvida')]));
  await waitFor(() => calls.find(call => call.href.includes('/sessions/session-ig/continueChat')));
  const next = await waitFor(() => calls.find(call => call.href.includes('/sessions/session-wa/continueChat')));
  assert.equal(next.body.message.text, 'Chegou durante a transcrição');
  assert.equal(calls.filter(call => call.href.endsWith('/audio/transcriptions')).length, 1);
  await post('/webhook/instagram', ig([igMessage('human-1', 'Atendimento manual', '500', user, { is_echo: true })]));
  const state = JSON.parse(await readFile(pauseFile, 'utf8'));
  assert.equal(state.length, 1);
  assert.match(state[0][0], /^[a-f0-9]{64}$/);
  assert.ok(state[0][1] > Date.now());
  await post('/webhook/instagram', ig([igMessage('paused', 'Ignorar durante pausa')]));
  assert.equal((await post('/admin/conversation', { channel: 'instagram', contact: user, action: 'resume' },
    { 'x-relay-token': admin }).then(res => res.json())).paused, false);
  await post('/webhook/instagram', ig([igMessage('resumed', 'Encaminhar duas demandas')]));
  const old = igMessage('expired', 'Janela expirada', '3333');
  old.timestamp -= 86401000;
  await post('/webhook/instagram', ig([old]));
  await waitFor(() => calls.find(call => call.href.includes('graph.instagram.com') &&
    call.body?.message?.text === 'Resposta de encaminhamento'));
  assert.equal(calls.some(call => call.body?.to === '5521999000002'), false);
  assert.deepEqual(JSON.parse(await readFile(pauseFile, 'utf8')), []);
  assert.equal(calls.some(call => /Bloqueado|Ignorado|durante pausa|Janela expirada/.test(call.body?.message?.text || '')), false);
});
