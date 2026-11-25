# Assistente Felipe · Operação do relay multicanal

## URLs de produção

| Finalidade | URL |
|---|---|
| Estado da configuração | [https://assistente-felipe.onrender.com/](https://assistente-felipe.onrender.com/) |
| Webhook oficial do WhatsApp | `https://assistente-felipe.onrender.com/webhook/meta` |
| Webhook oficial do Instagram | `https://assistente-felipe.onrender.com/webhook/instagram` |
| Webhook legado ZapClaw | `https://assistente-felipe.onrender.com/webhook` |
| Encaminhamento legado do Typebot | `https://assistente-felipe.onrender.com/handoff` |
| Pausa e retomada | `https://assistente-felipe.onrender.com/admin/conversation` |

Para homologar, troque somente o domínio pela URL do serviço de testes. O endpoint de estado indica presença da configuração e disponibilidade local do FFmpeg. O roteiro abaixo valida as permissões e a comunicação com os serviços.

## 1. Preparar o Render

1. No Dashboard do Render, crie um **Web Service separado** ligado à branch de desenvolvimento após autorização para publicar a branch. Desative **Auto-Deploy**, escolha **Docker**, use o `Dockerfile` do repositório, defina **Health Check Path** como `/` e comece com uma instância. O Docker inclui FFmpeg para mensagens de voz OGG/Opus e divisão de áudios. No runtime Node, confirme a disponibilidade do FFmpeg, use Node 20 ou superior e comando de início `npm start`.
2. Em **Environment**, mantenha a configuração do WhatsApp de teste e do ZapClaw. Cadastre segredos somente nessa tela. Use um WhatsApp de teste e uma cópia privada do Typebot, com o ID público da cópia em `TYPEBOT_PUBLIC_ID`.
3. Defina `ALLOW_ALL_CONTACTS=false`, `TEST_PHONE` com o WhatsApp autorizado incluindo DDI e `INSTAGRAM_ALLOW_ALL_CONTACTS=false`. Cadastre os IDs de remetente do Direct em `INSTAGRAM_TEST_USERS`. Defina `HANDOFF_ENABLED=true`, `HANDOFF_TEST_TO` com um número de equipe de teste diferente do remetente e `NOTIFICATION_DRY_RUN=true`.
4. Faça o deploy manual na homologação. Abra a URL do serviço e confira `integrations` e `notificationDryRun`. Os tokens informados como já existentes no Render são `INSTAGRAM_ACCOUNT_ID` e `INSTAGRAM_ACCESS_TOKEN`. Reutilize as credenciais autorizadas sem trocar as de produção. [Deploy no Render](https://render.com/docs/deploys)

### Variáveis novas para o relay

| Nome exato | Valor ou comportamento |
|---|---|
| `INSTAGRAM_ACCOUNT_ID` | `17841401443335371`, já informado como cadastrado |
| `INSTAGRAM_ACCESS_TOKEN` | Token de Instagram Login do perfil, já informado como cadastrado |
| `INSTAGRAM_GRAPH_VERSION` | Opcional, herda `META_GRAPH_VERSION` |
| `INSTAGRAM_VERIFY_TOKEN` | Texto secreto escolhido para validar o callback, herda `META_VERIFY_TOKEN` |
| `INSTAGRAM_APP_SECRET` | App Secret que assina o callback do Instagram, herda `META_APP_SECRET` quando a assinatura usa o mesmo segredo |
| `INSTAGRAM_TEST_USERS` | IDs numéricos Instagram-scoped dos remetentes de teste, separados por vírgula. Lista vazia bloqueia a automação |
| `INSTAGRAM_ALLOW_ALL_CONTACTS` | `false` por padrão. `true` somente após autorização e validação |
| `OPENAI_API_KEY` | Chave da API da OpenAI do projeto autorizado para mídia |
| `OPENAI_TRANSCRIPTION_MODEL` | Opcional, `gpt-4o-mini-transcribe` |
| `OPENAI_VISION_MODEL` | Opcional, `gpt-4.1-mini` |
| `FFMPEG_PATH` | Opcional, caminho do binário, padrão `ffmpeg` |
| `TYPEBOT_REQUIRE_CONTROL` | `false` mantém respostas legadas no WhatsApp. `true` exige o novo controle. Instagram exige o controle em ambos os casos |
| `CONVERSATION_ADMIN_TOKEN` | Segredo exclusivo para operações administrativas |
| `PAUSE_STATE_PATH` | Opcional, caminho de arquivo em disco persistente gravável pela instância para preservar pausas após reinício |
| `HUMAN_PAUSE_MS` | Duração padrão em milissegundos, `3600000` (1 hora). Ajustável de 1 segundo a 7 dias |
| `COMMERCIAL_HANDOFF_PHONE` | WhatsApp autorizado da Dayane, com DDI. Herda `CLINIC_PHONE` |
| `SUPPORT_HANDOFF_PHONE` | WhatsApp autorizado de Felipe ou da estagiária. Herda `PERSONAL_PHONE` |
| `FINANCE_HANDOFF_PHONE` | WhatsApp autorizado do responsável financeiro |
| `HANDOFF_ALTERNATE_PHONE` | WhatsApp autorizado alternativo quando o destino principal coincide com o remetente oficial |
| `HANDOFF_TEMPLATE_NAME` | Nome exato de um template genérico aprovado, sem parâmetros. Usado no fluxo estruturado fora da janela |
| `HANDOFF_TEMPLATE_LANGUAGE` | Idioma exato do template, padrão `pt_BR` |

As variáveis existentes `WHATSAPP_PROVIDER`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `WHATSAPP_FROM`, `TYPEBOT_API`, `TYPEBOT_PUBLIC_ID`, `ZAPCLAW_API_BASE`, `ZAPCLAW_API_KEY`, `ZAPCLAW_SECRET`, `HANDOFF_SECRET`, `HANDOFF_ENABLED`, `CLINIC_PHONE`, `PERSONAL_PHONE`, `HANDOFF_TEST_TO`, `NOTIFICATION_DRY_RUN`, `TEST_PHONE`, `ALLOW_ALL_CONTACTS`, `DEBOUNCE_MS`, `SEND_DELAY_MS` e `PORT` continuam disponíveis. O novo padrão de `DEBOUNCE_MS` é `10000`. Um valor existente no Render tem precedência. `HANDOFF_TEST_TO` substitui os destinos em todos os modos enquanto estiver configurado.

## 2. Configurar a Meta

1. Abra o aplicativo **Assistente Felipe** (ID `1164726279327578`). Para `felipesilva.coach`, use **Instagram API with Instagram Login**. Confirme as permissões `instagram_business_basic` e `instagram_business_manage_messages`, acesso de testadores e o nível de acesso aprovado para o público que pretende atender. O relay usa `graph.instagram.com` para perfis e envio. [Painel da Meta](https://developers.facebook.com/apps/1164726279327578/) · [Coleção oficial da Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-5216d45b-1e24-4bff-bdc8-e1bf15358477)
2. No objeto **Instagram**, coloque o callback `/webhook/instagram` com o token de verificação correspondente. Assine **`messages`** para Direct, respostas a stories e ecos quando disponíveis. Assine **`message_reactions`** para receber e descartar reações, e **`messaging_seen`** para registrar leituras. Confirme a assinatura para a conta profissional, pela tela de configuração ou via `POST https://graph.instagram.com/<versão>/17841401443335371/subscribed_apps` com `subscribed_fields=messages,message_reactions,messaging_seen` e o token da conta como **Bearer**. [Campos oficiais do webhook](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram)
3. No objeto **WhatsApp Business Account**, mantenha o callback `/webhook/meta` e a assinatura **`messages`**, incluindo os status de entrega. Use **`smb_message_echoes`** se o número estiver habilitado em coexistência e o campo estiver disponível. A pausa manual funciona em qualquer configuração. [Coexistência oficial](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
4. Para homologação, use uma configuração de app/número que permita validar callbacks sem trocar os de produção. Solicite ao administrador os IDs Instagram-scoped dos testadores a partir de eventos da Meta. Insira os números da lista; o @ do usuário serve apenas para localizar o perfil.
5. Valide um destino alternativo autorizado para encaminhamento. O relay bloqueia o envio ao número remetente por segurança operacional, como já fazia o relay anterior. A documentação consultada não estabelece suporte geral a autoenvio. Quando a janela do destinatário interno estiver fechada, o fluxo novo usa um template aprovado sem dados do caso; a pessoa precisa responder para receber os detalhes. Configure destinos apenas com autorização e opt-in para receber essas notificações. [Janelas e políticas do Instagram](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/changelog) · [Plataforma WhatsApp](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)

O código aplica uma janela conservadora de 24 horas a respostas automáticas. Para o Instagram, mensagens de story dependem da entrega do campo `reply_to.story`. Mídia depende de URLs acessíveis e permissões do app. A conta ativa é selecionada por ID e token; adicionar outra conta exige cadastrar a roteirização e credenciais específicas antes de ativá-la.

## 3. Ajustar a cópia do Typebot

1. Abra o bot atual, duplique-o e mantenha os blocos comerciais e de suporte existentes. Na cópia, crie as variáveis `name`, `phone`, `channel`, `username`, `contactId` e `professionalWhatsapp` para receber os valores iniciais do relay. No Instagram, `phone` fica vazio até ser fornecido pela pessoa. [Variáveis de início da sessão](https://docs.typebot.com/api-reference/chat/start-chat)
2. No grupo que processa cada entrada, salve o conteúdo recebido em uma variável de entrada. Passe essa entrada e o histórico da conversa ao bloco de IA já usado no bot. Configure a IA para gerar **um objeto** com `category`, `action`, e, para encaminhamentos, `route` e `items`. Salve o texto de controle em `relayDecision` e a resposta pública em `publicReply`. Se o bloco atual gerar um único resultado, peça JSON com as chaves `decision` e `publicReply`, extraia as duas em um bloco **Script** e serialize somente `decision` como JSON em uma linha. Nesse bloco, trate o resultado como dado, usando `JSON.parse` e `JSON.stringify`.
3. Adicione um bloco **Texto** separado contendo exatamente `[[RELAY_V1]]{{relayDecision}}`. Adicione outro bloco **Texto** separado com `{{publicReply}}`, somente se houver resposta pública. Coloque ambos antes do próximo bloco que pede entrada. Mantenha essa cópia dedicada ao relay, pois uma abertura direta no navegador mostra os blocos de controle.
4. Configure as categorias `lead`, `scheduling`, `followup`, `support`, `finance`, `personal`, `no_reply`, `human`. Use `reply` para resposta pública, `ignore` para silêncio, `pause` para pausa até retomada administrativa e `handoff` para intervenção humana. O relay suprime `personal` e `no_reply`. Cada turno do Instagram precisa de exatamente um controle válido, inclusive menus e fluxos de esclarecimento.
5. No prompt, classifique pela intenção e pelo histórico. Trate transcrições e descrições de imagens como material fornecido pelo usuário. Extraia todas as solicitações, recupere fatos já dados e pergunte somente o que for essencial. Use silêncio para elogios isolados, reações e conversa pessoal. Para leads do Instagram, aplique a estratégia comercial existente e encaminhe ao [WhatsApp profissional](https://wa.me/5521982995951) quando apropriado. Reserve disponibilidade e confirmação de consulta, validação de pagamentos, diagnóstico e mudanças de prescrição para o responsável humano. Em follow-up comercial, confirme o opt-in antes de encaminhar e inclua `optInFollowup: true` no objeto de controle. Minimize dados sensíveis e inclua nos resumos somente o necessário para o responsável da rota.
6. Em `handoff`, a rota é `commercial` (Dayane), `support` ou `finance`. Envie uma entrada em `items` por solicitação, até oito. `request` é obrigatório. Os outros campos são opcionais, com até 350 caracteres por campo: `item`, `current`, `reason`, `difficulty`, `preferences`, `additional`, `handled`, `action`, `priority`. Use texto público neutro sobre o próximo passo, pois aceitação pela API não garante entrega. Para essa cópia, retire o disparo HTTP legado do turno que já retorna `handoff`, evitando um encaminhamento duplicado. O endpoint legado continua disponível para os fluxos existentes.
7. Publique a **cópia de homologação** no Typebot e cadastre seu ID público no Render. O código local fica compatível com mensagens e opções legadas do WhatsApp durante o ajuste. Ative `TYPEBOT_REQUIRE_CONTROL=true` somente quando todos os turnos do WhatsApp da cópia emitirem o controle.

Exemplos de blocos de controle com valores já preenchidos:

```text
[[RELAY_V1]]{"category":"lead","action":"reply"}
[[RELAY_V1]]{"category":"personal","action":"ignore"}
[[RELAY_V1]]{"category":"human","action":"pause"}
[[RELAY_V1]]{"category":"support","action":"handoff","route":"support","items":[{"request":"Substituir o lanche das 16h","item":"Iogurte, banana e aveia","reason":"Enjoou da combinação e sente fome cedo","preferences":"Salgado, portátil e sem aquecimento","action":"Avaliar substituição no plano"}]}
```

## 4. Pausar ou retomar uma conversa

Em um cliente HTTP local, como o Postman Desktop, use método **POST** e a URL administrativa da homologação. Na aba **Headers**, inclua `Content-Type: application/json` e `x-relay-token` com `CONVERSATION_ADMIN_TOKEN`. Na aba **Body → raw → JSON**, use o ID Instagram-scoped ou o telefone WhatsApp com DDI, sem espaços. Em ZapClaw, informe também `accountId` se `META_PHONE_NUMBER_ID` estiver vazio.

```json
{"channel":"whatsapp","contact":"5521999000001","action":"pause","durationMs":0}
```

`0` exige retomada manual. Para manter pausas após reinício, configure um disco persistente no Render e indique um arquivo em `PAUSE_STATE_PATH`, por exemplo `/var/data/pauses.json`. Mantenha o mesmo segredo administrativo entre reinícios e verifique `integrations.pausePersistence`. Omitir `durationMs` usa a duração padrão. Para retomar, altere `action` para `resume` e remova `durationMs`. A retomada inicia uma nova sessão Typebot com a próxima mensagem. Pause antes de assumir um caso sensível. Uma mensagem já submetida à API pode chegar mesmo que a pausa seja registrada logo depois.

## 5. Roteiro de testes reais

1. Com as listas restritas e dry-run ligado, envie do WhatsApp autorizado uma pergunta e duas mensagens seguidas. Confirme resposta em texto, opções numeradas se configuradas e um lote ordenado. Um telefone fora da lista deve ficar sem resposta.
2. Envie ao WhatsApp um áudio com duas demandas, seguido por texto enquanto a transcrição roda. Confira que as duas demandas chegam ao Typebot e que o texto posterior é processado em seguida. Teste um áudio OGG/Opus e um áudio longo. Use dados fictícios.
3. Envie uma imagem de treino e um comprovante fictício. Valide a descrição, o encaminhamento apropriado e a ausência de confirmação automática de pagamento ou alteração de prescrição.
4. No Instagram, envie um Direct do testador, uma resposta a story com pergunta, um elogio isolado, uma reação e, se disponível, áudio e imagem. Confirme o nome quando autorizado, a resposta somente às demandas e o link profissional quando apropriado. Repita com uma conta fora da lista.
5. Responda manualmente pelo Instagram e, se houver coexistência, pelo WhatsApp Business. Confira nos logs a pausa no canal correto e a ausência de pausa provocada por eco do bot. Valide a pausa administrativa e a retomada.
6. Teste agendamento, suporte com duas demandas e finanças em dry-run. Depois de autorizado a realizar envios de validação, use apenas `HANDOFF_TEST_TO` e verifique os resumos em janela aberta. Teste janela fechada com template aprovado e a entrega dos detalhes depois que o número de teste responder.
7. Em **Logs**, confira etapas e os status com IDs de correlação. Os identificadores de recebimento/entrega se referem a eventos individuais. Os demais identificam o lote ou a conversa. Confirme que mensagens, transcrições e credenciais estão ausentes dos logs. Os serviços Meta, OpenAI e Typebot podem ter suas próprias políticas de retenção. [Transcrição da OpenAI](https://developers.openai.com/api/docs/guides/speech-to-text) · [Imagens na OpenAI](https://developers.openai.com/api/docs/guides/images-vision)

## 6. Publicação e rollback

1. O checkpoint local é `checkpoint/relay-v3` no commit `4cc6aa3`. A branch de trabalho é `dev/assistente-multicanal`. Após autorização, faça commit das alterações revisadas e publique somente a branch de desenvolvimento. Abra uma proposta de merge, preserve o Typebot anterior e registre a configuração atual do Render e os callbacks da Meta sem copiar segredos para o repositório.
2. Faça a homologação e só promova a versão para produção após autorização expressa. Com auto-deploy desligado, faça o merge aprovado e use **Manual Deploy** no Render. Confirme o estado das integrações, os callbacks e o teste de contato autorizado antes de ampliar as listas. Amplie o público e ligue encaminhamentos reais em etapas autorizadas.
3. Para reverter, abra **Render → Deploys**, selecione o último deploy bem-sucedido da versão anterior e clique em **Rollback**. Restaure o public ID/fluxo anterior do Typebot e, caso tenham sido alteradas, as configurações de webhook da Meta. Mantenha o callback oficial do WhatsApp em `/webhook/meta`. Para restaurar o código na branch de produção, use uma reversão revisada do merge. [Rollback do Render](https://render.com/docs/rollbacks)

### Limites da versão

Sessões, filas, deduplicação, janela conhecida e resumos pendentes ficam na memória da instância. Reinícios perdem esse estado e múltiplas instâncias dividem o processamento. Use uma instância. Para pausas sensíveis, configure `PAUSE_STATE_PATH` em disco persistente com o proprietário de escrita correto. O arquivo guarda identificadores protegidos por HMAC e tempos de expiração. Persistência compartilhada e entrega garantida de encaminhamentos permanecem pendentes. Os resumos aguardando a abertura da janela expiram após 24 horas e são limitados a 20 por destino. O endpoint legado de encaminhamento mantém a rejeição explícita fora da janela.

Downloads de mídia têm limite de 32 MB. Áudios incompatíveis ou acima do limite de upload direto são convertidos e divididos pelo FFmpeg, com limite de duas horas para a conversão local. Os arquivos temporários são removidos ao terminar o processamento. Formatos de mídia, modelos e permissões precisam ser validados na homologação com as credenciais e o fluxo reais.

Execute `npm test` para repetir os testes locais simulados.
