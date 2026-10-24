import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { KnowledgeIndex, parsePack, faqEntries, answerKnowledge } from '../src/knowledge';
it('probe', async () => {
  const p = parsePack(readFileSync('../../knowledge/dist/knowledge-pack.json', 'utf8'))!;
  const loaded = { info: { source: 'bundled' as const, seq: 1, builtAt: p.builtAt }, index: new KnowledgeIndex(p), faq: faqEntries(p.chunks) };
  const deps = { load: async () => loaded, liveAllowed: () => false, refreshing: () => true, runningVersion: '2.0.3', facts: () => ({}) };
  for (const q of ['How do you count tokens?', 'Does Atlas send my files to the cloud?', 'How does Atlas update?', 'What can Atlas do on my computer?', 'Does Nova require an account?', 'What is Replay.GG?', 'Is Atlas safe?', 'What is Nova Cut?', 'Can Atlas use a local model?', 'What does the emergency stop do in Atlas?', 'Why does Atlas count uncertain tokens toward the monthly limit?']) {
    const r = await answerKnowledge(q, deps, { modelUsable: false });
    console.log('\nQ:', q, '\n ->', r.kind === 'say' ? r.text.replace(/\n+/g, ' / ').slice(0, 420) : r.kind);
  }
});
