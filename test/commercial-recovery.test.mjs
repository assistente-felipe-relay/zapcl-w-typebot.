import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';

const phone = '5521999000001';
const business = '5521999000000';
const destination = '5521999000002';
const signatureSecret = 'mock-signature-secret';

const decision = (category, action, fields = {}) =>
  '[[RELAY_V1]]' + JSON.stringify({ category, action, ...fields });
const reply = decision('lead', 'reply');
const handoff = decision('lead', 'handoff', {
  route: 'commercial', items: [{ request: 'Verificar condições com a recepção' }],
});

async function setup(t, notifyEnabled = false, dryRun = true) {
  Object.assign(process.env, {
    ALLOW_ALL_CONTACTS: 'false', HANDOFF_ENABLED: String(notifyEnabled),
    NOTIFICATION_DRY_RUN: String(dryRun), WHATSAPP_PROVIDER: 'meta',
    TYPEBOT_REQUIRE_CONTROL: 'true', TYPEBOT_API: 'https://typebot.invalid/api',
    PORT: '0', DEBOUNCE_MS: '5000', SEND_DELAY_MS: '0', TEST_PHONE: phone,
    META_ACCESS_TOKEN: 'mock-meta', META_APP_SECRET: signatureSecret, META_PHONE_NUMBER_ID: '99',
    HANDOFF_TEST_TO: destination, WHATSAPP_FROM: business, PAUSE_STATE_PATH: '',
  });
  const transport = globalThis.fetch;
  const logger = console.log;
  const logs = [];
  const wa = [];
  const typebot = [];
  let model = () => [reply, 'Quais condições seriam úteis para você?'];
  let send = () => Response.json({ messages: [{ id: String(wa.length) }] });
  console.log = line => logs.push(JSON.parse(line));
  globalThis.fetch = async (url, options) => {
    const href = String(url);
    const body = JSON.parse(options.body);
    if (href.startsWith('https://graph.facebook.com/')) {
      wa.push(body);
      return send(body);
    }
    assert.ok(href.startsWith('https://typebot.invalid/'));
    const call = { operation: href.split('/').at(-1), input: body.message.text };
    typebot.push(call);
    const output = await model(call);
    if (output instanceof Response) return output;
    return Response.json({
      sessionId: 'session-local',
      input: { type: 'text input' },
      messages: output.map(markdown => ({ type: 'text', content: { markdown } })),
    });
  };
  const { server } = await import('../relay.mjs?' + t.name);
  t.after(() => {
    console.log = logger;
    globalThis.fetch = transport;
    server.closeAllConnections();
    server.close();
  });
  if (!server.listening) await once(server, 'listening');
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/webhook/meta';
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let seq = 0;
  async function message(text, from = phone) {
    const id = String(++seq);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{
      field: 'messages', value: {
        metadata: { phone_number_id: '99', display_phone_number: business },
        messages: [{ id, from, timestamp: Math.floor(Date.now() / 1000), type: 'text', text: { body: text } }],
      },
    }] }] });
    const hmac = createHmac('sha256', signatureSecret).update(body).digest('hex');
    const result = await transport(endpoint, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=' + hmac } });
    assert.equal(result.status, 200);
    await result.text();
  }
  async function outcomeAfter(logOffset) {
    await setImmediate();
    t.mock.timers.tick(5001);
    for (let attempt = 0; attempt < 300; attempt++) {
      const outcome = logs.slice(logOffset).find(log => log.event === 'conversation_outcome');
      if (outcome) {
        await setImmediate();
        return outcome;
      }
      await setImmediate();
    }
    assert.fail('lote sem desfecho: ' + JSON.stringify(logs.slice(logOffset)));
  }

  return { message, outcomeAfter, logs, wa, typebot, setModel: fn => { model = fn; }, setSend: fn => { send = fn; } };
}

test('35 turnos comerciais preservam a sessão e recuperam falhas no relay', async t => {
  const f = await setup(t);
  const turns = new Map([
    [3, { input: 'O valor está acima do meu orçamento.', output: [reply, 'Qual faixa cabe no seu orçamento?'] }],
    [5, { input: 'Posso deixar para o mês que vem?', output: [reply, 'Podemos conversar quando for melhor para você.'] }],
    [7, { input: 'Antes de preço, qual condição faria sentido para vocês?', output: [reply, 'Vamos alinhar primeiro sua necessidade.'] }],
    [8, { output: [handoff, 'Quais horários são melhores?'], reason: 'handoff', status: 'disabled', expected: 'Quais horários são melhores?' }],
    [9, { output: [handoff, 'Encaminhei o pedido. Quais horários são melhores?'], reason: 'handoff_status_filtered', status: 'disabled', sendCount: 2, expected: 'Quais horários são melhores?' }],
    [10, { output: ['[[RELAY_V1]]inválido', 'Você prefere pela manhã?'], reason: 'invalid_control', expected: 'Você prefere pela manhã?' }],
    [11, { output: ['[[RELAY_V1]]inválido'], reason: 'invalid_control', expected: 'Pode reenviar' }],
    [12, { output: [decision('personal', 'ignore'), 'Texto suprimido'], silent: 'intentional_silence' }],
    [13, { output: [reply], reason: 'empty_public_reply', expected: 'Pode reenviar' }],
    [14, { output: [handoff], reason: 'handoff', status: 'disabled', expected: 'não consegui concluir' }],
    [15, { output: [reply + '\nPodemos avaliar opções.'], expected: 'Podemos avaliar opções.' }],
    [16, { output: [reply, handoff, 'Você prefere esta semana?'], reason: 'duplicate_control', expected: 'Você prefere esta semana?' }],
    [17, { input: 'E para duas pessoas?', output: new Response(null, { status: 429 }), reason: 'typebot_failed', expected: 'Pode reenviar' }],
    [18, { output: [reply, 'Pagamento confirmado. Qual sua disponibilidade?'], reason: 'unverified_action_filtered', expected: 'Qual sua disponibilidade?' }],
    [19, { output: new Response(null, { status: 503 }), reason: 'typebot_failed', expected: 'Pode reenviar' }],
    [20, { timeout: true, reason: 'typebot_failed', expected: 'Pode reenviar' }],
    [21, { output: [decision('no_reply', 'ignore')], silent: 'intentional_silence' }],
    [22, { output: ['{"decision":{"category":"lead"},"publicReply":"texto interno"}'], reason: 'unsafe_public_text', expected: 'Pode reenviar' }],
    [23, { output: ['Resposta sem controle'], reason: 'missing_control', expected: 'Pode reenviar' }],
    [24, { fragments: ['O plano é mensal?', 'E o valor no Pix?'] }],
    [25, { invalidSession: true }],
    [26, { sendFailure: true, silent: 'send_failed' }],
    [28, { fragments: ['Prefiro adiar.', 'Quais condições ficam disponíveis?'] }],
    [31, { output: [decision('lead', 'ignore')], silent: 'intentional_silence' }],
  ]);
  let current;
  f.setModel(({ operation }) => {
    if (current.timeout) throw new DOMException('simulado', 'TimeoutError');
    if (current.invalidSession && operation === 'continueChat') return new Response(null, { status: 404 });
    return current.output || [reply, 'Vamos avaliar condições para sua necessidade.'];
  });
  f.setSend(() => current.sendFailure ? new Response(null, { status: 503 }) :
    Response.json({ messages: [{ id: String(f.wa.length) }] }));

  for (let turn = 1; turn <= 35; turn++) {
    current = turns.get(turn) || {};
    const offset = f.logs.length;
    const sends = f.wa.length;
    const calls = f.typebot.length;
    const text = current.input || 'Solicitação comercial ' + turn;
    if (current.fragments) {
      await f.message(current.fragments[0]);
      t.mock.timers.tick(3000);
      await f.message(current.fragments[1]);
      t.mock.timers.tick(2500);
      assert.equal(f.typebot.length, calls, 'a última mensagem reinicia o debounce');
    } else {
      await f.message(text);
    }
    const outcome = await f.outcomeAfter(offset);
    assert.equal(outcome.reason, current.silent || 'reply_sent', 'turno ' + turn);
    if (current.reason) assert.equal(outcome.detail, current.reason, 'turno ' + turn);
    if (current.status) assert.equal(outcome.handoffResult, current.status);
    const outgoing = f.wa.slice(sends);
    if (current.silent !== 'send_failed') assert.equal(outgoing.length, current.silent ? 0 : (current.sendCount || 1), 'turno ' + turn);
    if (current.expected) assert.ok(outgoing.some(message => message.text.body.includes(current.expected)), 'turno ' + turn);
    const modelCalls = f.typebot.slice(calls);
    assert.equal(modelCalls.length, current.invalidSession ? 2 : 1, 'turno ' + turn);
    assert.equal(modelCalls[0].operation, turn === 1 ? 'startChat' : 'continueChat');
    assert.equal(modelCalls[0].input, current.fragments?.join('\n') || text);
  }
  assert.equal(f.typebot.filter(call => call.operation === 'startChat').length, 2);
  assert.ok(f.wa.every(message => message.to === phone && !/RELAY_V1|texto interno|Encaminhei|Pagamento confirmado/.test(message.text.body)));
});

test('dry-run preserva texto neutro e nunca confirma o encaminhamento', async t => {
  const f = await setup(t, true);
  f.setModel(() => [handoff, 'A recepção já recebeu seu pedido. Qual sua disponibilidade?']);
  await f.message('Quero uma avaliação');
  const outcome = await f.outcomeAfter(0);
  assert.equal(outcome.handoffResult, 'dry_run');
  assert.equal(f.wa[0].text.body, 'Qual sua disponibilidade?');
  assert.ok(f.wa.every(message => message.to === phone && !/já recebeu/.test(message.text.body)));
});

test('recusa e exceção do provedor de encaminhamento preservam a resposta e a conversa', async t => {
  // This isolated process replaces every provider call with a local mock.
  const f = await setup(t, true, false);
  await f.message('Abrir janela simulada', destination);
  let failByException = false;
  f.setSend(body => {
    if (body.to !== destination) return Response.json({ messages: [{ id: String(f.wa.length) }] });
    if (failByException) throw new TypeError('rede simulada');
    return new Response(null, { status: 503 });
  });
  f.setModel(() => [handoff, 'Já encaminhei sua solicitação. Você prefere de manhã?']);
  for (const expected of ['failed', 'exception']) {
    const offset = f.logs.length;
    const outgoing = f.wa.length;
    await f.message('Minha preferência é quinta');
    const result = await f.outcomeAfter(offset);
    assert.equal(result.handoffResult, expected);
    assert.equal(result.reason, 'reply_sent');
    const client = f.wa.slice(outgoing).filter(message => message.to === phone);
    assert.match(client[0].text.body, /Você prefere de manhã/);
    assert.ok(client.every(message => !message.text.body.includes('Já encaminhei')));
    failByException = true;
  }
  f.setModel(() => [reply, 'Posso esclarecer outras condições.']);
  const offset = f.logs.length;
  await f.message('Ainda tenho uma dúvida');
  assert.equal((await f.outcomeAfter(offset)).reason, 'reply_sent');
  assert.equal(f.typebot.at(-1).operation, 'continueChat');
});
