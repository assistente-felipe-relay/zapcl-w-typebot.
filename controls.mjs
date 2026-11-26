const classifications = new Set([
  'lead', 'scheduling', 'followup', 'support', 'finance', 'personal', 'no_reply', 'human',
]);

export const supportFields = {
  request: 'Solicitação específica',
  item: 'Refeição, exercício ou item envolvido',
  current: 'Situação atual',
  reason: 'Motivo da solicitação',
  difficulty: 'Principal dificuldade',
  preferences: 'Preferências e restrições',
  additional: 'Informações adicionais relevantes',
  handled: 'Ação já realizada pela IA',
  action: 'Ação necessária do profissional',
  priority: 'Prioridade',
};

const marker = '[[RELAY_V1]]';

export function isPublicText(text) {
  return !!text.trim() && !/\[\[|[{}]|```|\b(?:RELAY_V1|relayDecision|publicReply|HANDOFF_ENABLED|NOTIFICATION_DRY_RUN|dry_run|optInFollowup)\b/i.test(text);
}

function validControl(control) {
  if (!control || !classifications.has(control.category) ||
      !['reply', 'ignore', 'pause', 'handoff'].includes(control.action)) return false;
  if (control.action !== 'handoff') return true;
  return (control.category !== 'followup' || control.optInFollowup === true) &&
    ['commercial', 'support', 'finance'].includes(control.route) &&
    Array.isArray(control.items) && control.items.length >= 1 && control.items.length <= 8 &&
    control.items.every(item => item && typeof item === 'object' &&
      typeof item.request === 'string' && item.request.trim() &&
      Object.entries(item).every(([key, value]) => Object.hasOwn(supportFields, key) &&
        typeof value === 'string' && value.length <= 350));
}

function parseControl(text) {
  try {
    return { control: JSON.parse(text), publicReply: '' };
  } catch {
    const boundary = text.indexOf('\n');
    if (boundary < 0) return {};
    try {
      return { control: JSON.parse(text.slice(0, boundary)), publicReply: text.slice(boundary + 1).trim() };
    } catch {
      return {};
    }
  }
}

export function typebotControls(bubbles, required) {
  const messages = [];
  let control;
  let issue;
  let controlCount = 0;
  for (const bubble of bubbles) {
    const line = bubble.trim();
    if (!line) continue;
    if (line === '[[SEM_RESPOSTA]]') return { messages: [], reason: 'intentional_silence' };
    if (line.startsWith(marker)) {
      controlCount++;
      const parsed = parseControl(line.slice(marker.length).trim());
      if (!validControl(parsed.control)) {
        issue = 'invalid_control';
        continue;
      }
      control = parsed.control;
      if (['personal', 'no_reply'].includes(control.category) || control.action === 'ignore') {
        return { messages: [], control, reason: 'intentional_silence' };
      }
      if (!parsed.publicReply) continue;
      if (isPublicText(parsed.publicReply)) messages.push(parsed.publicReply);
      else issue = 'unsafe_public_text';
    } else if (isPublicText(line)) {
      messages.push(line);
    } else {
      issue = 'unsafe_public_text';
    }
  }
  if (controlCount > 1) issue = 'duplicate_control';
  if (!issue && required && !control) issue = 'missing_control';
  // Malformed or ambiguous output cannot trigger routing or a pause. Independently safe
  // text may still be used when an attempted control failed validation.
  if (issue) {
    return { messages: issue === 'missing_control' ? [] : messages, reason: issue };
  }
  return { messages, control };
}
