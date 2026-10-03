/** A scientific calculator, a unit converter and a password generator. */

import { webApp } from './web-app';

// ------------------------------------------------------------------------------------ CALCULATOR

const CALC_LOGIC = String.raw`/*
 * {{NAME}} - a scientific calculator with a real expression parser. There is no eval() anywhere:
 * the text is turned into tokens, parsed by recursive descent and worked out directly, so nothing
 * you type can run as code.
 *
 *   precedence   ! and % (postfix)  >  ^ (right to left)  >  unary -  >  * / mod  >  + -
 *   so           -2^2 = -4,   2^3^2 = 512,   2^-1 = 0.5
 *   percent      200 + 10% = 220 (a percent of the left side after + or -),  50% = 0.5,  200 * 10% = 20
 *   implicit *   2pi,  3(4+5),  2sin(30),  (1+2)(3+4)
 */
(function (root) {
  'use strict';

  var CONSTS = { pi: Math.PI, e: Math.E, phi: (1 + Math.sqrt(5)) / 2, tau: 2 * Math.PI };

  function fail(msg) { var e = new Error(msg); e.calc = true; throw e; }

  function factorial(n) {
    if (n < 0 || Math.floor(n) !== n) fail('Factorial needs a whole number, 0 or more');
    if (n > 170) fail('That factorial is too large');
    var r = 1; for (var i = 2; i <= n; i++) r *= i;
    return r;
  }
  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a; }
  function whole(x, name) { if (Math.floor(x) !== x) fail(name + ' needs whole numbers'); return x; }
  function nCr(n, k) {
    whole(n, 'nCr'); whole(k, 'nCr');
    if (k < 0 || k > n) fail('nCr needs 0 <= k <= n');
    k = Math.min(k, n - k);
    var r = 1; for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;       // stays exact for the sizes that fit
    return Math.round(r);
  }
  function nPr(n, k) {
    whole(n, 'nPr'); whole(k, 'nPr');
    if (k < 0 || k > n) fail('nPr needs 0 <= k <= n');
    var r = 1; for (var i = 0; i < k; i++) r *= n - i;
    return r;
  }

  function toRad(x, deg) { return deg ? x * Math.PI / 180 : x; }
  function fromRad(x, deg) { return deg ? x * 180 / Math.PI : x; }

  // name -> [minArgs, maxArgs, fn(args, deg)]
  var FUNCS = {
    sin: [1, 1, function (a, d) { return Math.sin(toRad(a[0], d)); }],
    cos: [1, 1, function (a, d) { return Math.cos(toRad(a[0], d)); }],
    tan: [1, 1, function (a, d) { return Math.tan(toRad(a[0], d)); }],
    asin: [1, 1, function (a, d) { if (Math.abs(a[0]) > 1) fail('asin needs a number from -1 to 1'); return fromRad(Math.asin(a[0]), d); }],
    acos: [1, 1, function (a, d) { if (Math.abs(a[0]) > 1) fail('acos needs a number from -1 to 1'); return fromRad(Math.acos(a[0]), d); }],
    atan: [1, 1, function (a, d) { return fromRad(Math.atan(a[0]), d); }],
    atan2: [2, 2, function (a, d) { return fromRad(Math.atan2(a[0], a[1]), d); }],
    sinh: [1, 1, function (a) { return Math.sinh(a[0]); }],
    cosh: [1, 1, function (a) { return Math.cosh(a[0]); }],
    tanh: [1, 1, function (a) { return Math.tanh(a[0]); }],
    sqrt: [1, 1, function (a) { if (a[0] < 0) fail('The square root of a negative number is not a real number'); return Math.sqrt(a[0]); }],
    cbrt: [1, 1, function (a) { return Math.cbrt(a[0]); }],
    root: [2, 2, function (a) { if (a[0] === 0) fail('Root 0 does not exist'); if (a[1] < 0 && a[0] % 2 === 0) fail('An even root of a negative number is not real'); return a[1] < 0 ? -Math.pow(-a[1], 1 / a[0]) : Math.pow(a[1], 1 / a[0]); }],
    abs: [1, 1, function (a) { return Math.abs(a[0]); }],
    ln: [1, 1, function (a) { if (a[0] <= 0) fail('ln needs a positive number'); return Math.log(a[0]); }],
    log: [1, 2, function (a) { if (a[0] <= 0) fail('log needs a positive number'); if (a.length === 2) { if (a[1] <= 0 || a[1] === 1) fail('That is not a valid base'); return Math.log(a[0]) / Math.log(a[1]); } return Math.log10(a[0]); }],
    log2: [1, 1, function (a) { if (a[0] <= 0) fail('log2 needs a positive number'); return Math.log2(a[0]); }],
    exp: [1, 1, function (a) { return Math.exp(a[0]); }],
    pow: [2, 2, function (a) { return Math.pow(a[0], a[1]); }],
    floor: [1, 1, function (a) { return Math.floor(a[0]); }],
    ceil: [1, 1, function (a) { return Math.ceil(a[0]); }],
    round: [1, 2, function (a) { var p = Math.pow(10, a.length === 2 ? a[1] : 0); return Math.round(a[0] * p) / p; }],
    trunc: [1, 1, function (a) { return Math.trunc(a[0]); }],
    sign: [1, 1, function (a) { return Math.sign(a[0]); }],
    fact: [1, 1, function (a) { return factorial(a[0]); }],
    ncr: [2, 2, function (a) { return nCr(a[0], a[1]); }],
    npr: [2, 2, function (a) { return nPr(a[0], a[1]); }],
    mod: [2, 2, function (a) { if (a[1] === 0) fail('Division by zero'); var r = a[0] % a[1]; return r !== 0 && (r < 0) !== (a[1] < 0) ? r + a[1] : r; }],
    gcd: [2, 2, function (a) { return gcd(whole(a[0], 'gcd'), whole(a[1], 'gcd')); }],
    lcm: [2, 2, function (a) { var g = gcd(whole(a[0], 'lcm'), whole(a[1], 'lcm')); return g === 0 ? 0 : Math.abs(a[0] * a[1]) / g; }],
    min: [1, 99, function (a) { return Math.min.apply(null, a); }],
    max: [1, 99, function (a) { return Math.max.apply(null, a); }],
    sum: [1, 99, function (a) { return a.reduce(function (t, x) { return t + x; }, 0); }],
    avg: [1, 99, function (a) { return a.reduce(function (t, x) { return t + x; }, 0) / a.length; }]
  };

  // ---- tokens
  function tokenize(src) {
    var s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt ');
    var tokens = [], i = 0, m;
    while (i < s.length) {
      var c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i)))) { tokens.push({ t: 'num', v: parseFloat(m[0]), at: i }); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_]+/.exec(s.slice(i)))) {
        // Letters make a name. Digits join it only for names that really have them (log2, atan2),
        // so "sin30" is sin applied to 30 rather than one unknown word.
        var word = m[0].toLowerCase(), digits = /^\d+/.exec(s.slice(i + m[0].length));
        if (digits && Object.prototype.hasOwnProperty.call(FUNCS, word + digits[0])) { word += digits[0]; i += digits[0].length; }
        tokens.push({ t: 'name', v: word, at: i }); i += m[0].length; continue;
      }
      if ('+-*/^!%(),'.indexOf(c) >= 0) { tokens.push({ t: c, at: i }); i++; continue; }
      fail('Unexpected "' + c + '"');
    }
    return tokens;
  }

  // ---- parser / evaluator
  function evaluate(src, options) {
    options = options || {};
    var deg = options.angle !== 'rad', ans = options.ans === undefined ? 0 : options.ans;
    var toks = tokenize(src), pos = 0, depth = 0;
    if (!toks.length) fail('Type something to work out');

    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }
    function is(t) { return peek() && peek().t === t; }
    function startsOperand(tk) { return tk && (tk.t === 'num' || tk.t === 'name' || tk.t === '('); }
    function check(v) {
      if (typeof v !== 'number' || v !== v) fail('That is not a number');
      return v;
    }

    function expr() {
      var left = term();
      while (is('+') || is('-')) {
        var op = next().t, r = term();
        // "200 + 10%" means 10% OF 200
        var rv = r.pct ? left.v * r.v : r.v;
        left = { v: op === '+' ? left.v + rv : left.v - rv, pct: false };
      }
      return left;
    }

    function term() {
      var left = unary();
      for (;;) {
        if (is('*') || is('/')) {
          var op = next().t, r = unary();
          if (op === '/') { if (r.v === 0) fail('Division by zero'); left = { v: left.v / r.v, pct: false }; }
          else left = { v: left.v * r.v, pct: false };
        } else if (startsOperand(peek()) && !(peek().t === 'name' && peek().v === 'mod')) {
          var r2 = unary();                      // implicit multiplication: 2pi, 3(4+5)
          left = { v: left.v * r2.v, pct: false };
        } else if (peek() && peek().t === 'name' && peek().v === 'mod') {
          next(); var r3 = unary();
          if (r3.v === 0) fail('Division by zero');
          var m = left.v % r3.v; left = { v: m !== 0 && (m < 0) !== (r3.v < 0) ? m + r3.v : m, pct: false };
        } else return left;
      }
    }

    function unary() {
      if (is('-')) { next(); var u = unary(); return { v: -u.v, pct: u.pct }; }
      if (is('+')) { next(); return unary(); }
      return power();
    }

    function power() {
      var base = postfix();
      if (is('^')) { next(); var ex = unary(); return { v: check(Math.pow(base.v, ex.v)), pct: false }; }
      return base;
    }

    function postfix() {
      var p = primary();
      for (;;) {
        if (is('!')) { next(); p = { v: factorial(p.v), pct: false }; }
        else if (is('%')) { next(); p = { v: p.v / 100, pct: true }; }
        else return p;
      }
    }

    function args() {
      var list = [];
      if (is(')')) { next(); return list; }
      for (;;) {
        list.push(expr().v);
        if (is(',')) { next(); continue; }
        if (is(')')) { next(); return list; }
        fail('Missing )');
      }
    }

    function primary() {
      var tk = next();
      if (!tk) fail('The expression ends too soon');
      if (tk.t === 'num') return { v: tk.v, pct: false };
      if (tk.t === '(') {
        if (++depth > 200) fail('Too many brackets');
        var inner = expr();
        if (!is(')')) fail('Missing )');
        next(); depth--;
        return { v: inner.v, pct: false };
      }
      if (tk.t === 'name') {
        if (tk.v === 'ans') return { v: ans, pct: false };
        if (Object.prototype.hasOwnProperty.call(CONSTS, tk.v) && !is('(')) return { v: CONSTS[tk.v], pct: false };
        var name = tk.v === 'ncr' || tk.v === 'npr' ? tk.v : tk.v;
        var f = Object.prototype.hasOwnProperty.call(FUNCS, name) ? FUNCS[name] : null;
        if (!f) fail('I do not know "' + tk.v + '"');
        if (!is('(')) {                           // sqrt 16, sin 30
          var one = unary();
          if (f[0] > 1) fail(tk.v + ' needs brackets: ' + tk.v + '(a, b)');
          return { v: check(f[2]([one.v], deg)), pct: false };
        }
        next();
        var a = args();
        if (a.length < f[0] || a.length > f[1]) fail(tk.v + ' needs ' + (f[0] === f[1] ? f[0] : f[0] + ' to ' + f[1]) + ' number' + (f[1] === 1 ? '' : 's'));
        return { v: check(f[2](a, deg)), pct: false };
      }
      fail('Unexpected "' + tk.t + '"');
    }

    var result = expr();
    if (pos < toks.length) fail(toks[pos].t === ')' ? 'Missing (' : 'Unexpected "' + (toks[pos].v !== undefined ? toks[pos].v : toks[pos].t) + '"');
    return check(result.v);
  }

  // 12 significant digits, so 0.1 + 0.2 reads 0.3; whole numbers are shown in full.
  function format(n) {
    if (n !== n) return 'Error';
    if (!isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
    if (Number.isInteger(n) && Math.abs(n) < 1e21) {
      var s = BigInt(n).toString();
      return s.length > 21 ? Number(n).toExponential(11) : s;
    }
    var p = parseFloat(n.toPrecision(12));
    var a = Math.abs(p);
    if (a !== 0 && (a < 1e-6 || a >= 1e15)) return p.toExponential().replace('e+', 'e');
    return String(p);
  }

  // The friendly front door: never throws, tells you what went wrong.
  function calculate(src, options) {
    try { var v = evaluate(src, options); return { ok: true, value: v, text: format(v) }; }
    catch (e) { return { ok: false, error: e && e.calc ? e.message : 'That does not work' }; }
  }

  var api = { evaluate: evaluate, calculate: calculate, format: format, FUNCS: Object.keys(FUNCS), CONSTS: Object.keys(CONSTS) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== 'undefined' ? window : this);
`;

const CALC_TEST = String.raw`
const C = require('./logic.js');
const v = (s, o) => C.evaluate(s, o);
const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

test('the order of operations', () => {
  assert.strictEqual(v('2+3*4'), 14);
  assert.strictEqual(v('(2+3)*4'), 20);
  assert.strictEqual(v('10-4-3'), 3, 'subtraction goes left to right');
  assert.strictEqual(v('100/10/5'), 2);
  assert.strictEqual(v('2^3^2'), 512, 'powers go right to left');
  assert.strictEqual(v('-2^2'), -4);
  assert.strictEqual(v('(-2)^2'), 4);
  assert.strictEqual(v('2^-1'), 0.5);
  assert.strictEqual(v('--5'), 5);
  assert.strictEqual(v('3 - -2'), 5);
});

test('the symbols people actually type', () => {
  assert.strictEqual(v('6×7'), 42);
  assert.strictEqual(v('8÷2'), 4);
  assert.strictEqual(v('5−2'), 3);
  assert.ok(close(v('2π'), 2 * Math.PI));
  assert.ok(close(v('√16'), 4));
});

test('numbers: decimals, leading dot, scientific', () => {
  assert.strictEqual(v('.5+.25'), 0.75);
  assert.strictEqual(v('1.5e3'), 1500);
  assert.ok(close(v('2e-3'), 0.002));
  assert.ok(close(v('2e'), 2 * Math.E), '"2e" is two times e, not a broken number');
});

test('multiplying without a sign', () => {
  assert.ok(close(v('2pi'), 2 * Math.PI));
  assert.strictEqual(v('3(4+5)'), 27);
  assert.strictEqual(v('(1+2)(3+4)'), 21);
  assert.ok(close(v('2sin(30)'), 1));
  assert.strictEqual(v('2 3'), 6);
});

test('percent', () => {
  assert.strictEqual(v('200+10%'), 220);
  assert.strictEqual(v('200-10%'), 180);
  assert.strictEqual(v('50%'), 0.5);
  assert.strictEqual(v('200*10%'), 20);
  assert.strictEqual(v('50%*80'), 40);
});

test('trigonometry in degrees and in radians', () => {
  assert.ok(close(v('sin(30)'), 0.5));
  assert.ok(close(v('cos(60)'), 0.5));
  assert.ok(close(v('tan(45)'), 1));
  assert.ok(close(v('atan(1)'), 45));
  assert.ok(close(v('acos(0.5)'), 60));
  assert.ok(close(v('sin(pi/6)', { angle: 'rad' }), 0.5));
  assert.ok(close(v('atan(1)', { angle: 'rad' }), Math.PI / 4));
  assert.ok(close(v('atan2(1,1)'), 45));
});

test('roots, powers and logarithms', () => {
  assert.strictEqual(v('sqrt(16)'), 4);
  assert.strictEqual(v('sqrt 16'), 4);
  assert.strictEqual(v('cbrt(27)'), 3);
  assert.strictEqual(v('cbrt(-8)'), -2);
  assert.ok(close(v('root(4,81)'), 3));
  assert.strictEqual(v('log(1000)'), 3);
  assert.ok(close(v('log(8,2)'), 3));
  assert.ok(close(v('ln(e)'), 1));
  assert.strictEqual(v('log2(1024)'), 10);
  assert.strictEqual(v('pow(2,10)'), 1024);
  assert.ok(close(v('exp(1)'), Math.E));
});

test('counting: factorials, combinations, permutations', () => {
  assert.strictEqual(v('5!'), 120);
  assert.strictEqual(v('0!'), 1);
  assert.strictEqual(v('3!+1'), 7);
  assert.strictEqual(v('20!'), 2432902008176640000);
  assert.strictEqual(C.format(v('20!')), '2432902008176640000');
  assert.strictEqual(v('nCr(52,5)'), 2598960);
  assert.strictEqual(v('nCr(5,0)'), 1);
  assert.strictEqual(v('nPr(5,2)'), 20);
  assert.strictEqual(v('fact(6)'), 720);
});

test('number theory and statistics', () => {
  assert.strictEqual(v('gcd(12,18)'), 6);
  assert.strictEqual(v('lcm(4,6)'), 12);
  assert.strictEqual(v('mod(10,3)'), 1);
  assert.strictEqual(v('mod(-1,5)'), 4, 'the result takes the sign of the divisor');
  assert.strictEqual(v('10 mod 3'), 1);
  assert.strictEqual(v('max(1,5,3)'), 5);
  assert.strictEqual(v('min(4,2,8)'), 2);
  assert.strictEqual(v('sum(1,2,3,4)'), 10);
  assert.strictEqual(v('avg(2,4,6)'), 4);
});

test('rounding', () => {
  assert.strictEqual(v('round(2.5)'), 3);
  assert.strictEqual(v('round(3.14159,2)'), 3.14);
  assert.strictEqual(v('floor(-1.5)'), -2);
  assert.strictEqual(v('ceil(1.2)'), 2);
  assert.strictEqual(v('trunc(-1.9)'), -1);
});

test('constants and the previous answer', () => {
  assert.ok(close(v('pi'), Math.PI));
  assert.ok(close(v('phi'), 1.618033988749895));
  assert.ok(close(v('tau'), 2 * Math.PI));
  assert.strictEqual(v('ans*2', { ans: 21 }), 42);
});

test('answers read the way a person writes them', () => {
  assert.strictEqual(C.format(0.1 + 0.2), '0.3');
  assert.strictEqual(C.format(1 / 3), '0.333333333333');
  assert.strictEqual(C.format(1e21), '1e21');
  assert.strictEqual(C.format(1e-9), '1e-9');
  assert.strictEqual(C.format(-42), '-42');
  assert.strictEqual(C.format(1234567.891), '1234567.891');
  assert.strictEqual(C.calculate('0.1+0.2').text, '0.3');
});

test('mistakes are explained, not thrown at you', () => {
  const bad = (s, re) => { const r = C.calculate(s); assert.strictEqual(r.ok, false, s); assert.match(r.error, re, s); };
  bad('1/0', /zero/i);
  bad('0/0', /zero/i);
  bad('sqrt(-1)', /negative/i);
  bad('ln(0)', /positive/i);
  bad('(1+2', /\)/);
  bad('1+2)', /\(/);
  bad('2+', /ends too soon/);
  bad('foo(1)', /do not know/);
  bad('3.5!', /whole/);
  bad('171!', /too large/);
  bad('1 $ 2', /Unexpected/);
  bad('', /Type something/);
  bad('sin()', /needs 1/);
  bad('atan2(1)', /needs 2/);
  bad('asin(2)', /-1 to 1/);
  bad('mod(1,0)', /zero/i);
});

test('nothing typed can run as code', () => {
  ['process.exit()', 'constructor', '__proto__', 'alert(1)', 'this', 'x=1', '[]', '{}'].forEach((s) => {
    const r = C.calculate(s);
    assert.strictEqual(r.ok, false, s);
  });
});

test('deeply nested brackets are handled, and absurd ones refused', () => {
  assert.strictEqual(v('('.repeat(150) + '7' + ')'.repeat(150)), 7);
  assert.strictEqual(C.calculate('('.repeat(500) + '7' + ')'.repeat(500)).ok, false);
});

test('it agrees with JavaScript on a thousand random sums', () => {
  const rng = seeded(77);
  const ops = ['+', '-', '*'];
  function gen(d) {
    if (d === 0 || rng() < 0.25) return String(Math.floor(rng() * 20));
    const op = ops[Math.floor(rng() * 3)];
    const a = gen(d - 1), b = gen(d - 1);
    return rng() < 0.4 ? '(' + a + op + b + ')' : a + op + b;
  }
  for (let i = 0; i < 1000; i++) {
    const e = gen(4);
    const expected = Function('return (' + e + ')')();
    assert.ok(close(v(e), expected, 1e-6), e + ' -> ' + v(e) + ' vs ' + expected);
  }
});
done();
`;

const CALC_UI = String.raw`(function () {
  'use strict';
  var C = window.Calc, kit = window.kit;
  var input = kit.$('expr'), out = kit.$('result'), hist = kit.$('history');
  var angle = kit.load('angle', 'deg'), ans = 0, memory = kit.load('memory', 0), history = kit.load('history', []);

  var KEYS = [
    ['sin(', 'sin'], ['cos(', 'cos'], ['tan(', 'tan'], ['ln(', 'ln'], ['log(', 'log'],
    ['asin(', 'asin'], ['acos(', 'acos'], ['atan(', 'atan'], ['sqrt(', '√'], ['^', 'x^y'],
    ['pi', 'π'], ['e', 'e'], ['(', '('], [')', ')'], ['!', 'n!'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['/', '÷'], ['%', '%'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['*', '×'], ['ans', 'Ans'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['-', '−'], ['nCr(', 'nCr'],
    ['0', '0'], ['.', '.'], [',', ','], ['+', '+'], ['=', '=']
  ];
  var keys = kit.$('keys');
  KEYS.forEach(function (k) {
    var b = kit.el('button', 'key' + (k[0] === '=' ? ' eq' : '') + (/^\d|\./.test(k[0]) ? ' num' : ''), k[1]);
    b.type = 'button';
    b.addEventListener('click', function () { if (k[0] === '=') commit(); else insert(k[0]); });
    keys.appendChild(b);
  });

  function insert(text) {
    var s = input.selectionStart === null ? input.value.length : input.selectionStart, e = input.selectionEnd === null ? s : input.selectionEnd;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    var at = s + text.length; input.setSelectionRange(at, at); input.focus(); preview();
  }

  function preview() {
    if (!input.value.trim()) { out.textContent = ' '; out.className = 'result'; return; }
    var r = C.calculate(input.value, { angle: angle, ans: ans });
    out.textContent = r.ok ? '= ' + r.text : r.error;
    out.className = 'result' + (r.ok ? '' : ' bad');
  }

  function commit() {
    var r = C.calculate(input.value, { angle: angle, ans: ans });
    if (!r.ok) { kit.toast(r.error); return; }
    ans = r.value;
    history.unshift({ e: input.value, r: r.text }); history = history.slice(0, 30); kit.save('history', history);
    input.value = ''; out.textContent = '= ' + r.text; renderHistory(); stats();
  }

  function renderHistory() {
    hist.textContent = '';
    history.forEach(function (h) {
      var b = kit.el('button', 'h'); b.type = 'button';
      b.appendChild(kit.el('span', 'dim', h.e)); b.appendChild(kit.el('strong', '', '= ' + h.r));
      b.addEventListener('click', function () { insert(h.r); });
      hist.appendChild(b);
    });
    if (!history.length) hist.appendChild(kit.el('p', 'hint', 'Your sums will appear here.'));
  }

  function stats() { kit.stats([['Angles', angle === 'deg' ? 'degrees' : 'radians'], ['Memory', C.format(memory)], ['Ans', C.format(ans)]]); }

  input.addEventListener('input', preview);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { input.value = ''; preview(); }
  });
  kit.$('angle').addEventListener('click', function () { angle = angle === 'deg' ? 'rad' : 'deg'; kit.save('angle', angle); stats(); preview(); });
  kit.$('clear').addEventListener('click', function () { input.value = ''; preview(); input.focus(); });
  kit.$('back').addEventListener('click', function () { input.value = input.value.slice(0, -1); preview(); input.focus(); });
  function memOp(sign) {
    var r = C.calculate(input.value || 'ans', { angle: angle, ans: ans });
    if (!r.ok) { kit.toast(r.error); return; }
    memory = sign === 0 ? 0 : memory + sign * r.value; kit.save('memory', memory); stats();
  }
  kit.$('mc').addEventListener('click', function () { memOp(0); });
  kit.$('mp').addEventListener('click', function () { memOp(1); });
  kit.$('mm').addEventListener('click', function () { memOp(-1); });
  kit.$('mr').addEventListener('click', function () { insert(C.format(memory)); });
  kit.$('wipe').addEventListener('click', function () { history = []; kit.save('history', history); renderHistory(); });
  renderHistory(); stats(); input.focus();
})();
`;

export const calculatorApp = webApp({
  id: 'calculator',
  label: 'a calculator',
  summary: 'a scientific calculator with a real expression parser, history, memory and degrees or radians',
  group: 'tool',
  words: ['calculator', 'scientific calculator', 'calc app'],
  size: [900, 740],
  body: `      <div class="calc">
        <div class="card display"><input id="expr" autocomplete="off" spellcheck="false" placeholder="Type a sum: 2(3+4)^2, sin(30), 20!, nCr(52,5)" aria-label="Expression"><div id="result" class="result"> </div></div>
        <div class="row"><button class="btn small" id="angle" type="button">Deg / Rad</button><button class="btn small" id="mc" type="button">MC</button><button class="btn small" id="mp" type="button">M+</button><button class="btn small" id="mm" type="button">M-</button><button class="btn small" id="mr" type="button">MR</button><button class="btn small" id="back" type="button">Back</button><button class="btn small danger" id="clear" type="button">Clear</button></div>
        <div class="keys" id="keys"></div>
      </div>
      <div class="calc side card"><div class="row"><h2>History</h2><button class="btn small" id="wipe" type="button">Clear</button></div><div id="history" class="hist"></div></div>`,
  css: `
main { flex-direction: row; flex-wrap: wrap; align-items: flex-start; justify-content: center; }
.calc { width: min(100%, 380px); display: flex; flex-direction: column; gap: 10px; }
.display input { width: 100%; font-size: 20px; font-family: Consolas, "Cascadia Mono", monospace; }
.result { text-align: right; font-size: 30px; font-weight: 700; min-height: 44px; padding-top: 8px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.result.bad { color: var(--bad); font-size: 15px; font-weight: 400; }
.keys { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.key { padding: 12px 0; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font: 600 15px "Segoe UI", sans-serif; cursor: pointer; }
.key:hover { border-color: var(--purple2); background: #1a1030; } .key.num { background: #170d2c; } .key.eq { background: linear-gradient(135deg, var(--purple2), var(--purple)); border-color: transparent; color: #fff; }
.side { max-height: 520px; overflow-y: auto; }
.hist { display: flex; flex-direction: column; gap: 4px; }
.h { text-align: left; display: flex; flex-direction: column; background: none; border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; color: var(--text); font: inherit; cursor: pointer; }
.h:hover { background: #1a1030; border-color: var(--line); } .h span { font-size: 12px; font-family: Consolas, monospace; }
`,
  logic: CALC_LOGIC,
  ui: CALC_UI,
  test: CALC_TEST,
});

// ------------------------------------------------------------------------------------ UNIT CONVERTER

const CONVERT_LOGIC = String.raw`/*
 * {{NAME}} - unit conversion. Every unit is stored as a factor to its category's base unit
 * (metres, kilograms, litres...), so any unit converts to any other through the base. Temperature
 * is the exception (it has an offset, not just a scale), and goes through kelvin.
 */
(function (root) {
  'use strict';

  var CATEGORIES = {
    length: { label: 'Length', base: 'm', units: {
      km: ['kilometre', 1000], m: ['metre', 1], cm: ['centimetre', 0.01], mm: ['millimetre', 0.001], um: ['micrometre', 1e-6], nm: ['nanometre', 1e-9],
      mi: ['mile', 1609.344], yd: ['yard', 0.9144], ft: ['foot', 0.3048], in: ['inch', 0.0254], nmi: ['nautical mile', 1852], au: ['astronomical unit', 149597870700], ly: ['light year', 9460730472580800] } },
    mass: { label: 'Mass', base: 'kg', units: {
      t: ['tonne', 1000], kg: ['kilogram', 1], g: ['gram', 0.001], mg: ['milligram', 1e-6], lb: ['pound', 0.45359237], oz: ['ounce', 0.028349523125], st: ['stone', 6.35029318], ct: ['carat', 0.0002] } },
    volume: { label: 'Volume', base: 'l', units: {
      l: ['litre', 1], ml: ['millilitre', 0.001], m3: ['cubic metre', 1000], gal: ['US gallon', 3.785411784], qt: ['US quart', 0.946352946], pt: ['US pint', 0.473176473],
      cup: ['US cup', 0.2365882365], floz: ['US fluid ounce', 0.0295735295625], tbsp: ['US tablespoon', 0.01478676478125], tsp: ['US teaspoon', 0.00492892159375], igal: ['imperial gallon', 4.54609] } },
    area: { label: 'Area', base: 'm2', units: {
      km2: ['square kilometre', 1e6], ha: ['hectare', 10000], m2: ['square metre', 1], cm2: ['square centimetre', 1e-4], mi2: ['square mile', 2589988.110336],
      ac: ['acre', 4046.8564224], ft2: ['square foot', 0.09290304], in2: ['square inch', 0.00064516] } },
    speed: { label: 'Speed', base: 'ms', units: {
      ms: ['metre/second', 1], kmh: ['kilometre/hour', 1 / 3.6], mph: ['mile/hour', 0.44704], kn: ['knot', 1852 / 3600], fts: ['foot/second', 0.3048], c: ['speed of light', 299792458] } },
    time: { label: 'Time', base: 's', units: {
      ms: ['millisecond', 0.001], s: ['second', 1], min: ['minute', 60], h: ['hour', 3600], d: ['day', 86400], wk: ['week', 604800], yr: ['year (365.25 days)', 31557600] } },
    data: { label: 'Data', base: 'B', units: {
      bit: ['bit', 0.125], B: ['byte', 1], KB: ['kilobyte', 1e3], MB: ['megabyte', 1e6], GB: ['gigabyte', 1e9], TB: ['terabyte', 1e12],
      KiB: ['kibibyte', 1024], MiB: ['mebibyte', 1048576], GiB: ['gibibyte', 1073741824], TiB: ['tebibyte', 1099511627776] } },
    energy: { label: 'Energy', base: 'J', units: {
      J: ['joule', 1], kJ: ['kilojoule', 1000], cal: ['calorie', 4.184], kcal: ['kilocalorie', 4184], Wh: ['watt hour', 3600], kWh: ['kilowatt hour', 3.6e6], BTU: ['BTU', 1055.05585262], eV: ['electronvolt', 1.602176634e-19] } },
    pressure: { label: 'Pressure', base: 'Pa', units: {
      Pa: ['pascal', 1], kPa: ['kilopascal', 1000], bar: ['bar', 100000], atm: ['atmosphere', 101325], psi: ['pound/sq inch', 6894.757293168], mmHg: ['mm of mercury', 133.322387415] } },
    power: { label: 'Power', base: 'W', units: { W: ['watt', 1], kW: ['kilowatt', 1000], MW: ['megawatt', 1e6], hp: ['horsepower', 745.69987158227], PS: ['metric horsepower', 735.49875] } },
    angle: { label: 'Angle', base: 'rad', units: { rad: ['radian', 1], deg: ['degree', Math.PI / 180], grad: ['gradian', Math.PI / 200], turn: ['turn', 2 * Math.PI] } },
    temperature: { label: 'Temperature', base: 'K', special: true, units: { C: ['degree Celsius', 0], F: ['degree Fahrenheit', 0], K: ['kelvin', 0], R: ['degree Rankine', 0] } }
  };

  function toKelvin(v, u) { return u === 'C' ? v + 273.15 : u === 'F' ? (v + 459.67) * 5 / 9 : u === 'R' ? v * 5 / 9 : v; }
  function fromKelvin(k, u) { return u === 'C' ? k - 273.15 : u === 'F' ? k * 9 / 5 - 459.67 : u === 'R' ? k * 9 / 5 : k; }

  function convert(value, from, to, category) {
    var cat = CATEGORIES[category];
    if (!cat || !cat.units[from] || !cat.units[to]) throw new Error('Unknown unit');
    if (cat.special) {
      var k = toKelvin(value, from);
      if (k < 0) throw new Error('That is below absolute zero');
      return fromKelvin(k, to);
    }
    return value * cat.units[from][1] / cat.units[to][1];
  }

  // Short, readable numbers: 6 significant digits, no trailing zeros, exponent only when huge or tiny.
  function show(n) {
    if (n === 0) return '0';
    if (!isFinite(n)) return String(n);
    var a = Math.abs(n);
    if (a >= 1e9 || a < 1e-4) return n.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'e');
    return String(parseFloat(n.toPrecision(7)));
  }

  function table(value, from, category) {
    var cat = CATEGORIES[category];
    return Object.keys(cat.units).map(function (u) { return { unit: u, name: cat.units[u][0], value: convert(value, from, u, category) }; });
  }

  var api = { CATEGORIES: CATEGORIES, convert: convert, show: show, table: table };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Convert = api;
})(typeof window !== 'undefined' ? window : this);
`;

const CONVERT_TEST = String.raw`
const U = require('./logic.js');
const close = (a, b, rel) => Math.abs(a - b) <= (rel || 1e-9) * Math.max(1, Math.abs(a), Math.abs(b));

test('well-known conversions', () => {
  assert.ok(close(U.convert(1, 'mi', 'km', 'length'), 1.609344));
  assert.ok(close(U.convert(12, 'in', 'ft', 'length'), 1));
  assert.ok(close(U.convert(100, 'cm', 'm', 'length'), 1));
  assert.ok(close(U.convert(1, 'lb', 'kg', 'mass'), 0.45359237));
  assert.ok(close(U.convert(16, 'oz', 'lb', 'mass'), 1));
  assert.ok(close(U.convert(1, 'gal', 'l', 'volume'), 3.785411784));
  assert.ok(close(U.convert(1, 'gal', 'cup', 'volume'), 16));
  assert.ok(close(U.convert(1, 'tbsp', 'tsp', 'volume'), 3));
  assert.ok(close(U.convert(1, 'ac', 'ft2', 'area'), 43560));
  assert.ok(close(U.convert(1, 'ha', 'm2', 'area'), 10000));
  assert.ok(close(U.convert(60, 'mph', 'kmh', 'speed'), 96.56064));
  assert.ok(close(U.convert(1, 'h', 'min', 'time'), 60));
  assert.ok(close(U.convert(1, 'wk', 'h', 'time'), 168));
  assert.ok(close(U.convert(180, 'deg', 'rad', 'angle'), Math.PI));
  assert.ok(close(U.convert(1, 'turn', 'deg', 'angle'), 360));
  assert.ok(close(U.convert(1, 'atm', 'psi', 'pressure'), 14.6959487755, 1e-6));
  assert.ok(close(U.convert(1, 'kWh', 'J', 'energy'), 3.6e6));
  assert.ok(close(U.convert(1, 'kcal', 'cal', 'energy'), 1000));
  assert.ok(close(U.convert(1, 'hp', 'W', 'power'), 745.69987158227));
});

test('data sizes: decimal and binary prefixes are different things', () => {
  assert.strictEqual(U.convert(1, 'GiB', 'B', 'data'), 1073741824);
  assert.strictEqual(U.convert(1, 'GB', 'B', 'data'), 1e9);
  assert.ok(close(U.convert(1, 'GB', 'GiB', 'data'), 0.9313225746154785));
  assert.strictEqual(U.convert(8, 'bit', 'B', 'data'), 1);
  assert.strictEqual(U.convert(1, 'TiB', 'GiB', 'data'), 1024);
});

test('temperature: the fixed points and the offsets', () => {
  assert.ok(close(U.convert(0, 'C', 'F', 'temperature'), 32));
  assert.ok(close(U.convert(100, 'C', 'F', 'temperature'), 212));
  assert.ok(close(U.convert(-40, 'C', 'F', 'temperature'), -40));
  assert.ok(close(U.convert(32, 'F', 'C', 'temperature'), 0));
  assert.ok(close(U.convert(0, 'C', 'K', 'temperature'), 273.15));
  assert.ok(close(U.convert(0, 'K', 'C', 'temperature'), -273.15));
  assert.ok(close(U.convert(98.6, 'F', 'C', 'temperature'), 37));
  assert.ok(close(U.convert(491.67, 'R', 'C', 'temperature'), 0, 1e-9));
});

test('below absolute zero is refused', () => {
  assert.throws(() => U.convert(-300, 'C', 'F', 'temperature'), /absolute zero/);
  assert.throws(() => U.convert(-1, 'K', 'C', 'temperature'), /absolute zero/);
});

test('converting there and back gives the start, for every pair of units in every category', () => {
  Object.keys(U.CATEGORIES).forEach((cat) => {
    const units = Object.keys(U.CATEGORIES[cat].units);
    units.forEach((a) => units.forEach((b) => {
      const start = cat === 'temperature' ? 300 : 12.5;
      const back = U.convert(U.convert(start, a, b, cat), b, a, cat);
      assert.ok(close(back, start, 1e-9), cat + ' ' + a + '<->' + b + ' gave ' + back);
    }));
  });
});

test('a unit to itself is unchanged, and an unknown unit is an error', () => {
  assert.strictEqual(U.convert(7, 'km', 'km', 'length'), 7);
  assert.throws(() => U.convert(1, 'parsec', 'm', 'length'), /Unknown/);
  assert.throws(() => U.convert(1, 'm', 'kg', 'length'), /Unknown/);
  assert.throws(() => U.convert(1, 'm', 'm', 'nonsense'), /Unknown/);
});

test('conversion is linear (except temperature), so doubling the input doubles the answer', () => {
  Object.keys(U.CATEGORIES).filter((c) => c !== 'temperature').forEach((cat) => {
    const units = Object.keys(U.CATEGORIES[cat].units);
    assert.ok(close(U.convert(2, units[0], units[1], cat), 2 * U.convert(1, units[0], units[1], cat)));
  });
});

test('every unit has a positive factor', () => {
  Object.keys(U.CATEGORIES).filter((c) => c !== 'temperature').forEach((cat) => {
    Object.entries(U.CATEGORIES[cat].units).forEach(([u, [name, f]]) => { assert.ok(f > 0 && name, cat + ' ' + u); });
  });
});

test('numbers are shown short and clean', () => {
  assert.strictEqual(U.show(0), '0');
  assert.strictEqual(U.show(1.609344), '1.609344');
  assert.strictEqual(U.show(0.1 + 0.2), '0.3');
  assert.strictEqual(U.show(1073741824), '1.07374e9');
  assert.strictEqual(U.show(0.00001234), '1.234e-5');
  assert.strictEqual(U.show(1500), '1500');
});

test('the all-units table has a row per unit', () => {
  const rows = U.table(1, 'km', 'length');
  assert.strictEqual(rows.length, Object.keys(U.CATEGORIES.length.units).length);
  assert.ok(close(rows.find((r) => r.unit === 'm').value, 1000));
});
done();
`;

const CONVERT_UI = String.raw`(function () {
  'use strict';
  var U = window.Convert, kit = window.kit;
  var cat = kit.load('cat', 'length'), from = kit.load('from', null), to = kit.load('to', null);
  var tabs = kit.$('tabs'), inA = kit.$('a'), inB = kit.$('b'), selA = kit.$('ua'), selB = kit.$('ub'), rows = kit.$('rows');

  function units() { return Object.keys(U.CATEGORIES[cat].units); }

  function fillSelect(sel, current) {
    sel.textContent = '';
    units().forEach(function (u) { var o = kit.el('option', '', u + ' - ' + U.CATEGORIES[cat].units[u][0]); o.value = u; sel.appendChild(o); });
    sel.value = current;
  }

  function setCategory(c) {
    cat = c;
    var list = units();
    if (!from || list.indexOf(from) < 0 || c !== kit.load('cat', cat)) { from = list[0]; to = list[1] || list[0]; }
    kit.save('cat', cat); kit.save('from', from); kit.save('to', to);
    fillSelect(selA, from); fillSelect(selB, to);
    Array.prototype.forEach.call(tabs.children, function (b) { b.classList.toggle('on', b.dataset.c === cat); });
    if (!inA.value) inA.value = '1';
    fromA();
  }

  function problem(msg) { kit.$('err').textContent = msg || ''; }

  function fromA() {
    var x = parseFloat(inA.value.replace(',', '.'));
    if (isNaN(x)) { inB.value = ''; rows.textContent = ''; problem(inA.value ? 'That is not a number' : ''); return; }
    try { inB.value = U.show(U.convert(x, selA.value, selB.value, cat)); problem(''); } catch (e) { inB.value = ''; problem(e.message); }
    all(x);
  }
  function fromB() {
    var x = parseFloat(inB.value.replace(',', '.'));
    if (isNaN(x)) { inA.value = ''; return; }
    try { inA.value = U.show(U.convert(x, selB.value, selA.value, cat)); problem(''); } catch (e) { problem(e.message); }
    var a = parseFloat(inA.value); if (!isNaN(a)) all(a);
  }

  function all(x) {
    rows.textContent = '';
    try {
      U.table(x, selA.value, cat).forEach(function (r) {
        var row = kit.el('div', 'trow' + (r.unit === selB.value ? ' on' : ''));
        row.appendChild(kit.el('span', 'dim', r.name)); row.appendChild(kit.el('strong', '', U.show(r.value) + ' ' + r.unit));
        rows.appendChild(row);
      });
    } catch (e) { /* the message is already shown */ }
  }

  Object.keys(U.CATEGORIES).forEach(function (c) {
    var b = kit.el('button', 'btn small', U.CATEGORIES[c].label); b.type = 'button'; b.dataset.c = c;
    b.addEventListener('click', function () { from = null; setCategory(c); });
    tabs.appendChild(b);
  });
  inA.addEventListener('input', fromA); inB.addEventListener('input', fromB);
  selA.addEventListener('change', function () { from = selA.value; kit.save('from', from); fromA(); });
  selB.addEventListener('change', function () { to = selB.value; kit.save('to', to); fromA(); });
  kit.$('swap').addEventListener('click', function () {
    var t = selA.value; selA.value = selB.value; selB.value = t;
    from = selA.value; to = selB.value; kit.save('from', from); kit.save('to', to); fromA();
  });
  kit.$('copy').addEventListener('click', function () {
    if (navigator.clipboard) navigator.clipboard.writeText(inB.value + ' ' + selB.value).then(function () { kit.toast('Copied'); }, function () {});
  });
  kit.stats([['Categories', Object.keys(U.CATEGORIES).length], ['Units', Object.keys(U.CATEGORIES).reduce(function (t, c) { return t + Object.keys(U.CATEGORIES[c].units).length; }, 0)]]);
  var start = cat; cat = null; var saved = from; from = saved; cat = start;
  setCategory(cat);
})();
`;

export const converterApp = webApp({
  id: 'converter',
  label: 'a unit converter',
  summary: 'a unit converter for length, mass, volume, area, speed, time, data, energy, pressure, power, angle and temperature',
  group: 'tool',
  words: ['unit converter', 'converter app', 'unit conversion', 'measurement converter'],
  size: [760, 780],
  body: `      <div class="conv">
        <div class="row" id="tabs"></div>
        <div class="card pair">
          <div class="side-a"><input id="a" inputmode="decimal" autocomplete="off" aria-label="Value"><select id="ua" aria-label="From unit"></select></div>
          <button class="btn" id="swap" type="button" aria-label="Swap">&#8646;</button>
          <div class="side-b"><input id="b" inputmode="decimal" autocomplete="off" aria-label="Result"><select id="ub" aria-label="To unit"></select></div>
        </div>
        <p class="bad" id="err" aria-live="polite"></p>
        <div class="row"><button class="btn small" id="copy" type="button">Copy result</button></div>
        <div class="card"><h2>Everything at once</h2><div id="rows" class="rows"></div></div>
      </div>`,
  css: `
.conv { width: min(100%, 640px); display: flex; flex-direction: column; gap: 14px; }
.pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; }
.pair input, .pair select { width: 100%; } .pair input { font-size: 22px; margin-bottom: 8px; }
.rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 16px; }
.trow { display: flex; justify-content: space-between; gap: 8px; padding: 3px 6px; border-radius: 6px; font-size: 14px; }
.trow.on { background: #22143e; }
@media (max-width: 640px) { .pair { grid-template-columns: 1fr; } }
`,
  logic: CONVERT_LOGIC,
  ui: CONVERT_UI,
  test: CONVERT_TEST,
});

// ------------------------------------------------------------------------------------ PASSWORDS

const PASSWORD_LOGIC = String.raw`/*
 * {{NAME}} - password and passphrase generation. Pure logic; the page supplies randomness from the
 * browser's cryptographic generator (crypto.getRandomValues) through makeRandInt, which removes the
 * "modulo bias" a plain "% n" would add. Nothing is stored anywhere.
 */
(function (root) {
  'use strict';

  var SETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
    symbols: '!@#$%^&*()-_=+[]{};:,.?/'
  };
  var AMBIGUOUS = 'Il1O0o';

  // 256 short, common, easy-to-type words: 8 bits of entropy per word.
  var WORDS = ('able acid aged also area army atom aunt away baby back bake ball band bank barn base bath bead beam bean bear beat beef bell belt bend bike bill bird bite blue boat body bold bolt bond bone book boot born boss bowl bulk bull burn bush busy cafe cake calm camp card care cart case cash cast cave cell chef chip city clay clip club coal coat code coin cold cook cool cope copy cord core corn cost crew crop crow cube cure dark dash data dawn dear deck deep deer desk dial dice diet dirt dish dive dock dome door dove down draw drum duck dust duty each earn east easy echo edge epic even exit face fact fair fall farm fast fate fern film fire firm fish five flag flat flow foam fold folk food foot fork form fort four free frog fuel full fund gain game gate gear gift girl glad glow glue goat gold golf good gown grab gray grid grin grip gulf hair half hall hand hard harp hawk heap heat herb hero hill hint hive hold hole home hood hook hope horn host hour hunt idea inch iron isle jade jazz join joke jump june jury keen keep kind king kite knee knot lake lamb lamp land lane lark last lawn leaf lean left lens life lift lime line lion list live load loaf lock loft long loop lord loud love luck lung lynx mail main male mango maple mark mask mast meal melt menu mice mild milk mind').split(' ');

  function ceilLog2(x) { return Math.log2(x); }

  // fill(arrayOfUint32) must fill the array with uniform random 32-bit integers.
  function makeRandInt(fill) {
    return function (n) {
      if (!(n >= 1) || n > 4294967296) throw new Error('range out of bounds');
      var limit = 4294967296 - (4294967296 % n);               // reject the top sliver so every value is equally likely
      var buf = new Uint32Array(1);
      for (;;) { fill(buf); if (buf[0] < limit) return buf[0] % n; }
    };
  }

  function shuffle(list, randInt) {
    for (var i = list.length - 1; i > 0; i--) { var j = randInt(i + 1); var t = list[i]; list[i] = list[j]; list[j] = t; }
    return list;
  }

  function pools(opts) {
    var chosen = [];
    ['lower', 'upper', 'digits', 'symbols'].forEach(function (k) {
      if (!opts[k]) return;
      var chars = SETS[k];
      if (opts.noAmbiguous) chars = chars.split('').filter(function (c) { return AMBIGUOUS.indexOf(c) < 0; }).join('');
      if (chars) chosen.push(chars);
    });
    return chosen;
  }

  // opts: { length, lower, upper, digits, symbols, noAmbiguous }. At least one of each chosen kind is guaranteed.
  function generate(opts, randInt) {
    var sets = pools(opts);
    if (!sets.length) throw new Error('Pick at least one kind of character');
    var length = Math.max(sets.length, Math.min(128, Math.floor(opts.length || 16)));
    var all = sets.join('');
    var out = sets.map(function (s) { return s[randInt(s.length)]; });
    while (out.length < length) out.push(all[randInt(all.length)]);
    return shuffle(out, randInt).join('');
  }

  function entropyBits(opts) {
    var sets = pools(opts);
    if (!sets.length) return 0;
    var length = Math.max(sets.length, Math.min(128, Math.floor(opts.length || 16)));
    return length * ceilLog2(sets.join('').length);
  }

  // opts: { words, separator, capitalize, number }
  function passphrase(opts, randInt) {
    var n = Math.max(2, Math.min(12, Math.floor(opts.words || 4)));
    var parts = [];
    for (var i = 0; i < n; i++) {
      var w = WORDS[randInt(WORDS.length)];
      parts.push(opts.capitalize ? w.charAt(0).toUpperCase() + w.slice(1) : w);
    }
    if (opts.number) parts.push(String(randInt(100)));
    return parts.join(opts.separator === undefined ? '-' : opts.separator);
  }

  function passphraseEntropy(opts) {
    var n = Math.max(2, Math.min(12, Math.floor(opts.words || 4)));
    return n * ceilLog2(WORDS.length) + (opts.number ? ceilLog2(100) : 0);
  }

  function strength(bits) {
    return bits < 40 ? 'weak' : bits < 60 ? 'fair' : bits < 80 ? 'good' : 'strong';
  }

  var api = { SETS: SETS, WORDS: WORDS, AMBIGUOUS: AMBIGUOUS, makeRandInt: makeRandInt, shuffle: shuffle, generate: generate, entropyBits: entropyBits,
    passphrase: passphrase, passphraseEntropy: passphraseEntropy, strength: strength };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Passwords = api;
})(typeof window !== 'undefined' ? window : this);
`;

const PASSWORD_TEST = String.raw`
const P = require('./logic.js');

// A repeatable stand-in for the browser's random source.
function fillWith(rng) { return (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(rng() * 4294967296); }; }
const rand = (seed) => P.makeRandInt(fillWith(seeded(seed)));
const ALL = { length: 20, lower: true, upper: true, digits: true, symbols: true };

test('the passwords have the length asked for, from only the characters asked for', () => {
  const r = rand(1);
  for (let i = 0; i < 200; i++) {
    const pw = P.generate({ length: 24, lower: true, digits: true }, r);
    assert.strictEqual(pw.length, 24);
    assert.ok(/^[a-z0-9]+$/.test(pw), pw);
  }
});

test('every kind you switch on appears at least once, even in a short password', () => {
  const r = rand(2);
  for (let i = 0; i < 500; i++) {
    const pw = P.generate({ length: 4, lower: true, upper: true, digits: true, symbols: true }, r);
    assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw), pw);
  }
});

test('a length shorter than the number of kinds is raised to fit them', () => {
  assert.strictEqual(P.generate({ length: 1, lower: true, upper: true, digits: true }, rand(3)).length, 3);
});

test('lookalike characters can be left out', () => {
  const r = rand(4);
  for (let i = 0; i < 300; i++) {
    const pw = P.generate({ length: 40, lower: true, upper: true, digits: true, noAmbiguous: true }, r);
    assert.ok(!/[Il1O0o]/.test(pw), pw);
  }
});

test('switching everything off is an error, not an empty password', () => {
  assert.throws(() => P.generate({ length: 10 }, rand(5)), /at least one/);
});

test('the length is kept within sensible limits', () => {
  assert.strictEqual(P.generate({ length: 9999, lower: true }, rand(6)).length, 128);
  assert.strictEqual(P.generate({ lower: true }, rand(6)).length, 16);
});

test('entropy is length times log2 of the pool', () => {
  assert.ok(Math.abs(P.entropyBits({ length: 10, digits: true }) - 10 * Math.log2(10)) < 1e-9);
  assert.ok(Math.abs(P.entropyBits({ length: 16, lower: true, upper: true }) - 16 * Math.log2(52)) < 1e-9);
  assert.strictEqual(P.entropyBits({ length: 10 }), 0);
});

test('strength words follow the bits', () => {
  assert.deepStrictEqual([30, 50, 70, 100].map(P.strength), ['weak', 'fair', 'good', 'strong']);
});

test('the random helper throws away the biased top of the range', () => {
  // n = 10: values from 4294967290 up would favour 0..5, so they must be rejected.
  const seq = [4294967295, 4294967290, 17];
  let k = 0;
  const r = P.makeRandInt((arr) => { arr[0] = seq[k++]; });
  assert.strictEqual(r(10), 7);
  assert.strictEqual(k, 3);
});

test('and what it keeps is evenly spread', () => {
  const r = rand(7), counts = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) counts[r(7)]++;
  counts.forEach((c) => assert.ok(c > 9500 && c < 10500, 'counts ' + counts));
});

test('every character is about equally likely in a long run of passwords', () => {
  const r = rand(8), seen = {};
  for (let i = 0; i < 4000; i++) for (const ch of P.generate({ length: 10, digits: true }, r)) seen[ch] = (seen[ch] || 0) + 1;
  Object.values(seen).forEach((c) => assert.ok(c > 3600 && c < 4400, JSON.stringify(seen)));
});

test('shuffling keeps every item', () => {
  const out = P.shuffle([1, 2, 3, 4, 5, 6], rand(9));
  assert.deepStrictEqual(out.slice().sort(), [1, 2, 3, 4, 5, 6]);
});

test('the word list really has 256 different words', () => {
  assert.strictEqual(P.WORDS.length, 256);
  assert.strictEqual(new Set(P.WORDS).size, 256);
  P.WORDS.forEach((w) => assert.ok(/^[a-z]{3,6}$/.test(w), w));
});

test('passphrases', () => {
  const r = rand(10);
  const p = P.passphrase({ words: 4, separator: '-' }, r);
  assert.strictEqual(p.split('-').length, 4);
  p.split('-').forEach((w) => assert.ok(P.WORDS.includes(w)));
  assert.ok(/^([A-Z][a-z]+ ){2}[A-Z][a-z]+$/.test(P.passphrase({ words: 3, separator: ' ', capitalize: true }, r)));
  assert.ok(/-\d{1,2}$/.test(P.passphrase({ words: 3, number: true }, r)));
  assert.strictEqual(P.passphraseEntropy({ words: 5 }), 40);
  assert.ok(Math.abs(P.passphraseEntropy({ words: 4, number: true }) - (32 + Math.log2(100))) < 1e-9);
});
done();
`;

const PASSWORD_UI = String.raw`(function () {
  'use strict';
  var P = window.Passwords, kit = window.kit;
  var randInt = P.makeRandInt(function (arr) { crypto.getRandomValues(arr); });
  var mode = kit.load('mode', 'password');
  var opts = kit.load('opts', { length: 20, lower: true, upper: true, digits: true, symbols: true, noAmbiguous: false });
  var words = kit.load('words', { words: 6, separator: '-', capitalize: false, number: true });
  var recent = [];   // only in memory: passwords are never written to disk

  var out = kit.$('out');

  function readControls() {
    opts = { length: Number(kit.$('length').value), lower: kit.$('lower').checked, upper: kit.$('upper').checked, digits: kit.$('digits').checked, symbols: kit.$('symbols').checked, noAmbiguous: kit.$('amb').checked };
    words = { words: Number(kit.$('nwords').value), separator: kit.$('sep').value, capitalize: kit.$('cap').checked, number: kit.$('num').checked };
    kit.save('opts', opts); kit.save('words', words); kit.save('mode', mode);
  }

  function make() {
    readControls();
    kit.$('pw-opts').hidden = mode !== 'password'; kit.$('pp-opts').hidden = mode !== 'phrase';
    kit.$('len-label').textContent = opts.length; kit.$('nw-label').textContent = words.words;
    Array.prototype.forEach.call(kit.$('modes').children, function (b) { b.classList.toggle('on', b.dataset.m === mode); });
    try {
      var text = mode === 'password' ? P.generate(opts, randInt) : P.passphrase(words, randInt);
      var bits = mode === 'password' ? P.entropyBits(opts) : P.passphraseEntropy(words);
      out.textContent = text; out.classList.remove('bad');
      var word = P.strength(bits);
      kit.$('meter').style.width = Math.min(100, bits / 1.28) + '%';
      kit.$('meter').className = 'bar ' + word;
      kit.$('bits').textContent = Math.round(bits) + ' bits - ' + word;
      recent.unshift(text); recent = recent.slice(0, 6); renderRecent();
      kit.stats([['Strength', word], ['Entropy', Math.round(bits) + ' bits']]);
    } catch (e) { out.textContent = e.message; out.classList.add('bad'); kit.$('bits').textContent = ''; }
  }

  function renderRecent() {
    var host = kit.$('recent'); host.textContent = '';
    recent.slice(1).forEach(function (t) { var b = kit.el('button', 'rec mono', t); b.type = 'button'; b.addEventListener('click', function () { out.textContent = t; }); host.appendChild(b); });
  }

  kit.$('copy').addEventListener('click', function () {
    if (navigator.clipboard) navigator.clipboard.writeText(out.textContent).then(function () { kit.toast('Copied. Paste it somewhere safe.'); }, function () { kit.toast('Select it and press Ctrl+C.'); });
  });
  kit.$('again').addEventListener('click', make);
  ['password', 'phrase'].forEach(function (m) {
    var b = kit.el('button', 'btn small', m === 'password' ? 'Password' : 'Passphrase'); b.type = 'button'; b.dataset.m = m;
    b.addEventListener('click', function () { mode = m; make(); }); kit.$('modes').appendChild(b);
  });
  ['length', 'lower', 'upper', 'digits', 'symbols', 'amb', 'nwords', 'sep', 'cap', 'num'].forEach(function (id) { kit.$(id).addEventListener('input', make); });

  kit.$('length').value = opts.length; kit.$('lower').checked = opts.lower; kit.$('upper').checked = opts.upper; kit.$('digits').checked = opts.digits; kit.$('symbols').checked = opts.symbols; kit.$('amb').checked = opts.noAmbiguous;
  kit.$('nwords').value = words.words; kit.$('sep').value = words.separator; kit.$('cap').checked = words.capitalize; kit.$('num').checked = words.number;
  make();
})();
`;

export const passwordApp = webApp({
  id: 'password',
  label: 'a password generator',
  summary: 'a secure password and passphrase generator that uses the browser’s cryptographic randomness and never stores what it makes',
  group: 'tool',
  words: ['password generator', 'passphrase generator', 'password maker', 'password app'],
  size: [620, 780],
  body: `      <div class="pw">
        <div class="row" id="modes"></div>
        <div class="card"><div id="out" class="out mono" aria-live="polite"> </div><div class="meter"><div id="meter" class="bar"></div></div><div class="row"><span id="bits" class="dim"></span></div>
        <div class="row"><button class="btn primary" id="again" type="button">Generate another</button><button class="btn" id="copy" type="button">Copy</button></div></div>
        <div class="card" id="pw-opts"><label>Length: <b id="len-label"></b></label><input id="length" type="range" min="6" max="64"><div class="row opts"><label><input id="lower" type="checkbox"> a-z</label><label><input id="upper" type="checkbox"> A-Z</label><label><input id="digits" type="checkbox"> 0-9</label><label><input id="symbols" type="checkbox"> !@#$</label><label><input id="amb" type="checkbox"> no lookalikes (Il1O0o)</label></div></div>
        <div class="card" id="pp-opts" hidden><label>Words: <b id="nw-label"></b></label><input id="nwords" type="range" min="3" max="10"><div class="row opts"><label>Separator <input id="sep" maxlength="3" size="3"></label><label><input id="cap" type="checkbox"> Capitalise</label><label><input id="num" type="checkbox"> Add a number</label></div></div>
        <div class="card"><h2>Earlier this visit (not saved)</h2><div id="recent" class="recent"></div></div>
        <p class="hint">Passwords are made here, on this computer, and are not saved anywhere.</p>
      </div>`,
  css: `
.pw { width: min(100%, 560px); display: flex; flex-direction: column; gap: 14px; }
.out { font-size: 26px; text-align: center; word-break: break-all; padding: 14px 6px; min-height: 76px; color: var(--text); }
.out.bad { color: var(--bad); font-size: 15px; }
.meter { height: 8px; background: var(--bg2); border-radius: 999px; overflow: hidden; margin: 6px 0 10px; border: 1px solid var(--line); }
.bar { height: 100%; width: 0; border-radius: 999px; transition: width 0.25s; background: var(--bad); }
.bar.fair { background: var(--gold); } .bar.good { background: #84cc16; } .bar.strong { background: var(--good); }
.opts label { display: flex; align-items: center; gap: 6px; }
.pw input[type="range"] { width: 100%; margin: 6px 0 10px; }
.recent { display: flex; flex-direction: column; gap: 4px; }
.rec { text-align: left; background: none; border: 0; color: var(--dim); cursor: pointer; padding: 3px 6px; border-radius: 6px; word-break: break-all; }
.rec:hover { background: #1a1030; color: var(--text); }
`,
  logic: PASSWORD_LOGIC,
  ui: PASSWORD_UI,
  test: PASSWORD_TEST,
});
