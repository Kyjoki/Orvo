// Models exposed by the host's Codex model picker on 2026-10-19.
// These are suggestions, not a grant of access or an availability check.
export const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
] as const;

export const gatewayModelId = (id: string) => `openai/${id}`;
