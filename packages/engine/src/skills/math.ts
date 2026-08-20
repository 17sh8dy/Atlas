/**
 * A tiny arithmetic evaluator for `math.calculate`.
 *
 * Deliberately not `eval`/`new Function` — Atlas's whole safety story is
 * "nothing runs that wasn't declared and validated," and handing a string
 * straight to the JS engine is exactly the kind of thing that principle rules
 * out, even for something as harmless-looking as a calculator. A hand-rolled
 * tokenizer + shunting-yard + RPN evaluator only understands numbers and
 * `+ - * / ^ %`, so there is nothing here it could do besides arithmetic.
 */

type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' };

const OPERATORS: Record<string, { precedence: number; rightAssoc?: boolean }> = {
  '+': { precedence: 1 },
  '-': { precedence: 1 },
  '*': { precedence: 2 },
  '/': { precedence: 2 },
  '%': { precedence: 2 },
  '^': { precedence: 3, rightAssoc: true },
};

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === undefined) break;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: 'paren', value: c });
      i++;
      continue;
    }
    if (c in OPERATORS) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.]/.test(expr[j] ?? '')) j++;
      const raw = expr.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) return null;
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    return null; // an unrecognised character means this isn't a bare expression
  }
  return tokens;
}

/** Shunting-yard: infix tokens to postfix (RPN). */
function toRpn(tokens: Token[]): Token[] | null {
  const output: Token[] = [];
  const ops: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'num') {
      output.push(t);
    } else if (t.type === 'op') {
      const cur = OPERATORS[t.value];
      if (!cur) return null;
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (!top || top.type !== 'op') break;
        const topInfo = OPERATORS[top.value];
        if (!topInfo) break;
        const shouldPop = cur.rightAssoc
          ? topInfo.precedence > cur.precedence
          : topInfo.precedence >= cur.precedence;
        if (!shouldPop) break;
        output.push(ops.pop() as Token);
      }
      ops.push(t);
    } else if (t.value === '(') {
      ops.push(t);
    } else {
      let foundOpen = false;
      while (ops.length) {
        const top = ops.pop() as Token;
        if (top.type === 'paren' && top.value === '(') {
          foundOpen = true;
          break;
        }
        output.push(top);
      }
      if (!foundOpen) return null; // unbalanced parens
    }
  }
  while (ops.length) {
    const top = ops.pop() as Token;
    if (top.type === 'paren') return null; // unbalanced parens
    output.push(top);
  }
  return output;
}

function evalRpn(rpn: Token[]): number | null {
  const stack: number[] = [];
  for (const t of rpn) {
    if (t.type === 'num') {
      stack.push(t.value);
      continue;
    }
    if (t.type !== 'op') return null;
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return null;
    let result: number;
    switch (t.value) {
      case '+':
        result = a + b;
        break;
      case '-':
        result = a - b;
        break;
      case '*':
        result = a * b;
        break;
      case '/':
        if (b === 0) return null;
        result = a / b;
        break;
      case '%':
        if (b === 0) return null;
        result = a % b;
        break;
      case '^':
        result = a ** b;
        break;
      default:
        return null;
    }
    if (!Number.isFinite(result)) return null;
    stack.push(result);
  }
  return stack.length === 1 ? (stack[0] ?? null) : null;
}

/** Evaluates a bare arithmetic expression. Returns null for anything invalid. */
export function evaluateExpression(expr: string): number | null {
  const tokens = tokenize(expr);
  if (!tokens || !tokens.length) return null;
  const rpn = toRpn(tokens);
  if (!rpn) return null;
  return evalRpn(rpn);
}
