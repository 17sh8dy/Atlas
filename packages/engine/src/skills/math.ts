/**
 * A tiny arithmetic evaluator for `math.calculate`.
 *
 * Deliberately not `eval`/`new Function` — Atlas's whole safety story is
 * "nothing runs that wasn't declared and validated," and handing a string
 * straight to the JS engine is exactly the kind of thing that principle rules
 * out, even for something as harmless-looking as a calculator. A hand-rolled
 * tokenizer + recursive-descent parser only understands numbers, the operators
 * below, a closed list of functions and two constants, so there is nothing here
 * it could do besides arithmetic.
 *
 * It reads the way people actually type sums, not just the way a programmer
 * does: `88 x 535`, `12 × 7`, `100 ÷ 4`, `9 times 8`, `2 to the power of 10`,
 * `square root of 144`, `1,250 * 3`, `5!`, `-5 + 3`, `2(3 + 4)`, `50 * 10%`.
 * All of that is rewritten by `normalizeExpression` into one small syntax
 * before the parser sees it. The calculator is the one answer Atlas can always
 * give with no model at all, so it must not depend on phrasing a model would
 * have forgiven.
 */

type Token =
  | { type: 'num'; value: number; constant?: boolean }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' | '^' | '!' }
  | { type: 'func'; value: string }
  | { type: 'paren'; value: '(' | ')' };

const DEG = Math.PI / 180;

/** Trig reads degrees, like a desk calculator: "sin 30" means 0.5 to most people. */
function trig(fn: (x: number) => number): (x: number) => number {
  return (x) => {
    const r = fn(x * DEG);
    // cos(90°) is 6e-17 in floating point, not 0 — snap the noise away.
    return Math.abs(r) < 1e-12 ? 0 : r;
  };
}

const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  sin: trig(Math.sin),
  cos: trig(Math.cos),
  // tan(90°) is undefined, not 1.6e16.
  tan: (x) => (Math.abs(Math.cos(x * DEG)) < 1e-12 ? NaN : trig(Math.tan)(x)),
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Phrasings rewritten to the parser's syntax, in order (longest first where they overlap). */
const WORDS: Array<[RegExp, string]> = [
  [/\bmultiplied\s+by\b/g, '*'],
  [/\btimes\b/g, '*'],
  [/\bdivided\s+by\b/g, '/'],
  [/\bover\b/g, '/'],
  [/\bplus\b/g, '+'],
  [/\bminus\b/g, '-'],
  [/\b(?:to\s+the\s+power\s+of|raised\s+to(?:\s+the\s+power\s+of)?|to\s+the)\b/g, '^'],
  [/\bsquared\b/g, '^2'],
  [/\bcubed\b/g, '^3'],
  [/\bsquare\s+root\s+of\b/g, 'sqrt '],
  [/\bcube\s+root\s+of\b/g, 'cbrt '],
  [/\bmod(?:ulo)?\b/g, '%'],
  [/\bfactorial\s+of\s+(\d+)\b/g, '$1!'],
  // "log of 100", "sqrt of 16": the "of" adds nothing once the function is named.
  [/\b(sqrt|cbrt|abs|sin|cos|tan|log|ln|exp|round|floor|ceil)\s+of\b/g, '$1'],
];

/**
 * Rewrites how people type sums into the parser's syntax. Pure text work — it
 * decides nothing; anything it leaves unrecognised simply fails to parse.
 */
export function normalizeExpression(text: string): string {
  let s = text.toLowerCase().trim();
  s = s
    .replace(/[×⋅·∗]/g, '*')
    .replace(/[÷∕]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/√/g, 'sqrt ')
    .replace(/π/g, 'pi');
  // Trailing "?" / "=" — "88 x 535 =" is how a sum is written on paper.
  s = s.replace(/[\s?=]+$/, '');
  // Thousands separators: "1,250" is 1250. Only a comma followed by exactly
  // three digits, so "max(1,2)"-style input is not silently merged.
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  for (const [pattern, replacement] of WORDS) s = s.replace(pattern, replacement);
  // "x" is multiplication only BETWEEN operands — "88 x 535", "(2)x(3)", "5!x2".
  s = s.replace(/([\d.)!])\s*x\s*(?=[-\d.(]|pi\b|e\b|sqrt|cbrt|abs|sin|cos|tan|log|ln|exp|round|floor|ceil)/g, '$1 * ');
  return s;
}

function tokenize(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i] ?? '';
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ type: 'paren', value: c });
      i++;
      continue;
    }
    if ('+-*/%^!'.includes(c)) {
      tokens.push({ type: 'op', value: c as '+' });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.]/.test(expr[j] ?? '')) j++;
      const value = Number(expr.slice(i, j));
      if (Number.isNaN(value)) return null; // "1.0.3" is a version, not a number
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (/[a-z]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[a-z]/.test(expr[j] ?? '')) j++;
      const word = expr.slice(i, j);
      if (word in FUNCTIONS) tokens.push({ type: 'func', value: word });
      else if (word in CONSTANTS) tokens.push({ type: 'num', value: CONSTANTS[word]!, constant: true });
      else return null; // any other word means this isn't a bare expression
      i = j;
      continue;
    }
    return null; // an unrecognised character means this isn't a bare expression
  }
  return tokens;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

/**
 * Recursive descent, lowest precedence first:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary | <implicit *> unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := postfix ('^' unary)?          right-assoc; -2^2 = -4, 2^-1 = 0.5
 *   postfix := primary ('!' | '%')*          a trailing '%' is "percent"
 *   primary := number | '(' expr ')' | func primaryArg
 * Any NaN/Infinity anywhere makes the whole result null.
 */
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number | null {
    const value = this.expr();
    if (value === null || this.i !== this.tokens.length) return null;
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(t: Token | undefined, ...ops: string[]): boolean {
    return t?.type === 'op' && ops.includes(t.value);
  }

  /** Does `t` begin an operand? Used for implicit multiplication and the '%' ambiguity. */
  private startsOperand(t: Token | undefined): boolean {
    return !!t && (t.type === 'num' || t.type === 'func' || (t.type === 'paren' && t.value === '('));
  }

  private expr(): number | null {
    let left = this.term();
    while (left !== null && this.isOp(this.peek(), '+', '-')) {
      const op = (this.tokens[this.i++] as { value: string }).value;
      const right = this.term();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number | null {
    let left = this.unary();
    while (left !== null) {
      const t = this.peek();
      if (this.isOp(t, '*', '/', '%')) {
        this.i++;
        const right = this.unary();
        if (right === null) return null;
        const op = (t as { value: string }).value;
        if (op === '*') left = left * right;
        else if (right === 0) return null;
        else left = op === '/' ? left / right : left % right;
        // "2(3 + 4)", "2pi", "3 sqrt 4" — but NOT "2 3", which is two numbers,
        // not a product, and must never be claimed as a sum.
      } else if (this.startsOperand(t) && (t?.type !== 'num' || t.constant)) {
        const right = this.unary();
        if (right === null) return null;
        left = left * right;
      } else if (t?.type === 'num' && this.tokens[this.i - 1]?.type === 'paren') {
        const right = this.unary(); // "(1 + 2) 3"
        if (right === null) return null;
        left = left * right;
      } else break;
    }
    return left;
  }

  private unary(): number | null {
    if (this.isOp(this.peek(), '-', '+')) {
      const neg = (this.tokens[this.i++] as { value: string }).value === '-';
      const v = this.unary();
      return v === null ? null : neg ? -v : v;
    }
    return this.power();
  }

  private power(): number | null {
    const base = this.postfix();
    if (base === null) return null;
    if (this.isOp(this.peek(), '^')) {
      this.i++;
      const exponent = this.unary();
      if (exponent === null) return null;
      return base ** exponent;
    }
    return base;
  }

  private postfix(): number | null {
    let v = this.primary();
    while (v !== null) {
      const t = this.peek();
      if (this.isOp(t, '!')) {
        this.i++;
        v = factorial(v);
      } else if (
        this.isOp(t, '%') &&
        !this.startsOperand(this.tokens[this.i + 1]) &&
        !this.isOp(this.tokens[this.i + 1], '-', '+')
      ) {
        // "50 * 10%" — a '%' with no right-hand operand is a percentage.
        // "10 % 3" (operand follows) stays the remainder, as it always was.
        this.i++;
        v = v / 100;
      } else break;
    }
    return v;
  }

  private primary(): number | null {
    const t = this.tokens[this.i++];
    if (!t) return null;
    if (t.type === 'num') return t.value;
    if (t.type === 'paren' && t.value === '(') {
      const v = this.expr();
      const close = this.tokens[this.i++];
      if (v === null || close?.type !== 'paren' || close.value !== ')') return null;
      return v;
    }
    if (t.type === 'func') {
      // "sqrt(16)", "sqrt 16", "sqrt -4" (→ NaN → null)
      const arg = this.unary();
      if (arg === null) return null;
      return FUNCTIONS[t.value]!(arg);
    }
    return null;
  }
}

/** Evaluates a bare arithmetic expression. Returns null for anything invalid. */
export function evaluateExpression(expr: string): number | null {
  const tokens = tokenize(normalizeExpression(expr));
  if (!tokens || !tokens.length) return null;
  let result: number | null;
  try {
    result = new Parser(tokens).parse();
  } catch {
    return null; // deep nesting overflowing the stack is still just "not a sum"
  }
  if (result === null || !Number.isFinite(result)) return null;
  // 0.1 + 0.2 is 0.30000000000000004 in floating point; nobody asking wants that.
  const clean = Number(result.toPrecision(12));
  return Object.is(clean, -0) ? 0 : clean;
}

/**
 * Should a whole message, with no "what is" / "calculate" in front of it, be
 * treated as a sum? Stricter than `evaluateExpression`: it needs a digit and
 * something to DO (an operator or a function), so a lone "2024" or "pi" is
 * left to conversation; and it declines the shapes that are almost always
 * something else — dates ("9/26/2026", "2026-09-26") and phone numbers
 * ("555-123-4567").
 */
export function isBareCalculation(text: string): boolean {
  const s = normalizeExpression(text);
  if (!/\d/.test(s)) return false;
  if (!/[-+*/^%!]|[a-z]/.test(s)) return false;
  if (/^\d+(?:-\d+){2,}$/.test(s)) return false;
  if (/^\d{1,4}\/\d{1,2}\/\d{1,4}$/.test(s)) return false;
  return evaluateExpression(text) !== null;
}

/** "47080" → "47,080"; keeps exponents for the very large and very small. */
export function formatNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) return String(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: 10 });
}
