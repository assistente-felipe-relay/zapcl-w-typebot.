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

export function typebotControls(bubbles, required) {
  const messages = [];
  let control;
  for (const bubble of bubbles) {
    const line = bubble.trim();
    if (!line) continue;
    if (line === '[[SEM_RESPOSTA]]') return { messages: [], suppressed: true };
    if (!line.startsWith('[[RELAY_V1]]')) {
      if (/\[\[(?:RELAY|SEM_RESPOSTA)|(?:^|\n)\s*(?:```(?:json)?\s*\n\s*)?(?:\{\s*"|\[\s*\{)/i.test(line)) return { messages: [], suppressed: true };
      messages.push(line);
      continue;
    }
    if (control) return { messages: [], suppressed: true };
    try {
      control = JSON.parse(line.slice('[[RELAY_V1]]'.length));
    } catch {
      return { messages: [], suppressed: true };
    }
    if (!control || !classifications.has(control.category) ||
        !['reply', 'ignore', 'pause', 'handoff'].includes(control.action)) {
      return { messages: [], suppressed: true };
    }
    if (control.action === 'handoff') {
      if ((control.category === 'followup' && control.optInFollowup !== true) ||
          !['commercial', 'support', 'finance'].includes(control.route) ||
          !Array.isArray(control.items) || !control.items.length || control.items.length > 8 ||
          control.items.some(item => !item || typeof item !== 'object' ||
            typeof item.request !== 'string' || !item.request.trim() ||
            Object.keys(item).some(key => !Object.hasOwn(supportFields, key) ||
              typeof item[key] !== 'string' || item[key].length > 350))) {
        return { messages: [], suppressed: true };
      }
    }
  }
  if (required && !control) return { messages: [], suppressed: true };
  const silent = ['personal', 'no_reply'].includes(control?.category) || control?.action === 'ignore';
  return { messages: silent ? [] : messages, control: silent ? undefined : control, suppressed: silent };
}
