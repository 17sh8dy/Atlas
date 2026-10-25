/**
 * Questions about the files on this PC, understood without a model (see general/file-facts.ts).
 *
 * One rule. It claims a sentence only when `parseFileQuestion` reads it as a read-only question about a
 * place that is named in it, so "how many folders are there in: D:\Dev?" is answered by `files.facts`
 * and every other sentence passes through to the rules that were already there.
 */

import { parseFileQuestion } from '../general/file-facts';
import type { GrammarRule } from './grammar';
import { plan, step } from './grammar';

export function createFactsGrammar(): GrammarRule[] {
  return [
    {
      name: 'fileFacts',
      order: -11.9,
      pathSafe: true,
      questionSafe: ['file-facts'],
      test(_lower, raw) {
        const request = parseFileQuestion(raw);
        if (!request) return null;
        const args: Record<string, string> = { op: request.op };
        if ('path' in request) args.path = request.path;
        if ('thing' in request) args.thing = request.thing;
        if ('exts' in request && request.exts) args.exts = request.exts.join(',');
        if ('label' in request && request.label) args.label = request.label;
        if ('deep' in request && request.deep) args.deep = 'true';
        if ('which' in request) args.which = request.which;
        if ('name' in request && request.name) args.name = request.name;
        return plan(step('files.facts', args), 'file-facts');
      },
    },
  ];
}
