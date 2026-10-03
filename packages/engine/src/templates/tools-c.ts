/** A budget tracker, a habit tracker, a Kanban board and spaced-repetition flashcards. */

import { webApp } from './web-app';

// ------------------------------------------------------------------------------------ BUDGET

const BUDGET_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a budget tracker. Money is kept as WHOLE CENTS (integers), never as
 * decimals, so 0.10 + 0.20 is exactly 0.30 and totals never drift. Dates are 'YYYY-MM-DD'.
 */
(function (root) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // "12", "12.5", "$1,234.56" -> cents. Anything else -> null. Negative amounts are not allowed:
  // whether it is money in or out is the transaction's type.
  function parseMoney(text) {
    var m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
    if (!m) return null;
    var whole = parseInt(m[1].replace(/,/g, ''), 10);
    var cents = parseInt(((m[2] || '') + '00').slice(0, 2), 10);
    var total = whole * 100 + cents;
    return Number.isSafeInteger(total) ? total : null;
  }

  function format(cents, symbol) {
    symbol = symbol === undefined ? '$' : symbol;
    var neg = cents < 0, a = Math.abs(cents);
    var whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + symbol + whole + '.' + pad(a % 100);
  }

  function validDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var p = d.split('-'), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return dt.getUTCFullYear() === +p[0] && dt.getUTCMonth() === +p[1] - 1 && dt.getUTCDate() === +p[2];
  }
  function monthOf(date) { return date.slice(0, 7); }
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad(m + 1);
  }

  function create() { return { tx: [], nextId: 1, budgets: {} }; }

  function add(s, t) {
    if (!validDate(String(t.date))) throw new Error('That date is not valid');
    if (t.type !== 'income' && t.type !== 'expense') throw new Error('Choose income or expense');
    if (!Number.isInteger(t.cents) || t.cents <= 0) throw new Error('Enter an amount above zero');
    var category = String(t.category || '').trim().slice(0, 30) || (t.type === 'income' ? 'Income' : 'General');
    var item = { id: s.nextId++, date: t.date, type: t.type, cents: t.cents, category: category, note: String(t.note || '').trim().slice(0, 200) };
    s.tx.push(item);
    return item;
  }

  function remove(s, id) { var n = s.tx.length; s.tx = s.tx.filter(function (t) { return t.id !== id; }); return n !== s.tx.length; }

  function inMonth(s, ym) { return s.tx.filter(function (t) { return monthOf(t.date) === ym; }); }

  function summary(s, ym) {
    var list = inMonth(s, ym), income = 0, expense = 0, by = {};
    list.forEach(function (t) {
      if (t.type === 'income') income += t.cents;
      else { expense += t.cents; by[t.category] = (by[t.category] || 0) + t.cents; }
    });
    var cats = Object.keys(by).map(function (c) { return { category: c, cents: by[c], share: expense ? by[c] / expense : 0 }; });
    cats.sort(function (a, b) { return b.cents - a.cents || (a.category < b.category ? -1 : 1); });
    return { income: income, expense: expense, net: income - expense, byCategory: cats, count: list.length };
  }

  // The running balance across everything up to and including a date.
  function balance(s, upTo) {
    return s.tx.reduce(function (t, x) { return (!upTo || x.date <= upTo) ? t + (x.type === 'income' ? x.cents : -x.cents) : t; }, 0);
  }

  function setBudget(s, category, cents) {
    if (!cents) delete s.budgets[category]; else s.budgets[category] = cents;
  }

  // For each category that has a monthly limit: what was spent, what is left, how far through it is.
  function budgetStatus(s, ym) {
    var spent = {};
    inMonth(s, ym).forEach(function (t) { if (t.type === 'expense') spent[t.category] = (spent[t.category] || 0) + t.cents; });
    return Object.keys(s.budgets).map(function (c) {
      var limit = s.budgets[c], used = spent[c] || 0;
      return { category: c, limit: limit, spent: used, left: limit - used, pct: limit ? used / limit : 0, over: used > limit };
    }).sort(function (a, b) { return b.pct - a.pct; });
  }

  // The last n months, oldest first, for a chart.
  function series(s, endYm, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) { var ym = addMonths(endYm, -i), sum = summary(s, ym); out.push({ ym: ym, income: sum.income, expense: sum.expense }); }
    return out;
  }

  function months(s, current) {
    var seen = {}; seen[current] = true;
    s.tx.forEach(function (t) { seen[monthOf(t.date)] = true; });
    return Object.keys(seen).sort().reverse();
  }

  // ---- CSV. A spreadsheet runs a cell that starts with = + - @ as a formula, so those get a leading '.
  function csvField(v) {
    v = String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function toCSV(s) {
    var rows = ['date,type,category,amount,note'];
    s.tx.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; }).forEach(function (t) {
      rows.push([t.date, t.type, csvField(t.category), (t.cents / 100).toFixed(2), csvField(t.note)].join(','));
    });
    return rows.join('\n') + '\n';
  }

  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, q = false;
    text = String(text).replace(/^\uFEFF/, '');
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r[0] && r[0].trim()); });
  }

  function fromCSV(s, text) {
    var rows = parseCSV(text), added = 0, errors = [];
    if (!rows.length || rows[0].join(',').toLowerCase().indexOf('date,type') !== 0) return { added: 0, errors: ['The first line should be: date,type,category,amount,note'] };
    rows.slice(1).forEach(function (r, i) {
      function unprefix(v) { return /^'[=+\-@\t\r]/.test(v || '') ? v.slice(1) : (v || ''); }
      var cents = parseMoney(r[3] || '');
      try {
        if (cents === null) throw new Error('bad amount');
        add(s, { date: (r[0] || '').trim(), type: (r[1] || '').trim().toLowerCase(), category: unprefix(r[2]), cents: cents, note: unprefix(r[4]) });
        added++;
      } catch (e) { errors.push('Line ' + (i + 2) + ': ' + e.message); }
    });
    return { added: added, errors: errors };
  }

  var api = { parseMoney: parseMoney, format: format, validDate: validDate, monthOf: monthOf, addMonths: addMonths, create: create, add: add, remove: remove, inMonth: inMonth,
    summary: summary, balance: balance, setBudget: setBudget, budgetStatus: budgetStatus, series: series, months: months, toCSV: toCSV, fromCSV: fromCSV, parseCSV: parseCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Budget = api;
})(typeof window !== 'undefined' ? window : this);
`;

const BUDGET_TEST = String.raw`
const B = require('./logic.js');

test('money text becomes whole cents, and nothing else is accepted', () => {
  const ok = { '12': 1200, '12.5': 1250, '12.05': 1205, '$1,234.56': 123456, '0.99': 99, '  7 ': 700, '1000000': 100000000 };
  Object.entries(ok).forEach(([t, c]) => assert.strictEqual(B.parseMoney(t), c, t));
  ['', 'abc', '-5', '1.234', '12,34', '1,2345.00', '$', '1e3', '12.', '.5'].forEach((t) => assert.strictEqual(B.parseMoney(t), null, JSON.stringify(t)));
});

test('cents are shown as money, with a sign and thousands separators', () => {
  assert.strictEqual(B.format(123456), '$1,234.56');
  assert.strictEqual(B.format(5), '$0.05');
  assert.strictEqual(B.format(-250), '-$2.50');
  assert.strictEqual(B.format(100000000), '$1,000,000.00');
  assert.strictEqual(B.format(99, '£'), '£0.99');
});

test('adding up never drifts, because it is whole cents', () => {
  const s = B.create();
  for (let i = 0; i < 100; i++) B.add(s, { date: '2026-03-05', type: 'expense', cents: 10, category: 'x' });
  assert.strictEqual(B.summary(s, '2026-03').expense, 1000);
  B.add(s, { date: '2026-03-06', type: 'income', cents: B.parseMoney('0.10'), category: 'y' });
  B.add(s, { date: '2026-03-06', type: 'income', cents: B.parseMoney('0.20'), category: 'y' });
  assert.strictEqual(B.summary(s, '2026-03').income, 30);
});

test('bad entries are refused with a reason', () => {
  const s = B.create();
  assert.throws(() => B.add(s, { date: '2026-02-30', type: 'expense', cents: 100 }), /date/);
  assert.throws(() => B.add(s, { date: '2026-02-03', type: 'gift', cents: 100 }), /income or expense/);
  assert.throws(() => B.add(s, { date: '2026-02-03', type: 'expense', cents: 0 }), /above zero/);
  assert.throws(() => B.add(s, { date: '2026-02-03', type: 'expense', cents: 1.5 }), /above zero/);
  assert.strictEqual(s.tx.length, 0);
});

function sample() {
  const s = B.create();
  const add = (date, type, cents, category) => B.add(s, { date, type, cents, category });
  add('2026-03-01', 'income', 300000, 'Salary');
  add('2026-03-03', 'expense', 120000, 'Rent');
  add('2026-03-10', 'expense', 45000, 'Food');
  add('2026-03-20', 'expense', 15000, 'Food');
  add('2026-03-25', 'expense', 20000, 'Fun');
  add('2026-04-01', 'income', 300000, 'Salary');
  add('2026-04-02', 'expense', 130000, 'Rent');
  return s;
}

test('a month adds up: income, spending, what is left, and where it went', () => {
  const m = B.summary(sample(), '2026-03');
  assert.strictEqual(m.income, 300000);
  assert.strictEqual(m.expense, 200000);
  assert.strictEqual(m.net, 100000);
  assert.strictEqual(m.count, 5);
  assert.deepStrictEqual(m.byCategory.map((c) => c.category), ['Rent', 'Food', 'Fun']);
  assert.strictEqual(m.byCategory[1].cents, 60000);
  assert.ok(Math.abs(m.byCategory.reduce((t, c) => t + c.share, 0) - 1) < 1e-12, 'the shares make a whole');
});

test('the balance runs across months', () => {
  const s = sample();
  assert.strictEqual(B.balance(s), 600000 - 120000 - 45000 - 15000 - 20000 - 130000);
  assert.strictEqual(B.balance(s, '2026-03-31'), 100000);
});

test('budgets say how much of each limit is used and which are blown', () => {
  const s = sample();
  B.setBudget(s, 'Food', 50000); B.setBudget(s, 'Fun', 50000);
  const st = B.budgetStatus(s, '2026-03');
  assert.strictEqual(st[0].category, 'Food');
  assert.strictEqual(st[0].over, true);
  assert.strictEqual(st[0].left, -10000);
  assert.ok(Math.abs(st[0].pct - 1.2) < 1e-12);
  assert.strictEqual(st[1].over, false);
  B.setBudget(s, 'Food', 0);
  assert.strictEqual(B.budgetStatus(s, '2026-03').length, 1);
});

test('months roll over years correctly, in both directions', () => {
  assert.strictEqual(B.addMonths('2026-01', -1), '2025-12');
  assert.strictEqual(B.addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(B.addMonths('2026-03', -15), '2024-12');
  assert.strictEqual(B.addMonths('2026-03', 0), '2026-03');
});

test('the chart series is the last n months, oldest first, including empty ones', () => {
  const s = sample();
  const ser = B.series(s, '2026-05', 4);
  assert.deepStrictEqual(ser.map((x) => x.ym), ['2026-02', '2026-03', '2026-04', '2026-05']);
  assert.strictEqual(ser[0].expense, 0);
  assert.strictEqual(ser[2].expense, 130000);
});

test('the month list has every month used, plus this one, newest first', () => {
  assert.deepStrictEqual(B.months(sample(), '2026-06'), ['2026-06', '2026-04', '2026-03']);
});

test('deleting removes one entry', () => {
  const s = sample();
  assert.strictEqual(B.remove(s, 2), true);
  assert.strictEqual(B.remove(s, 999), false);
  assert.strictEqual(s.tx.length, 6);
});

test('a CSV export reads back to the same data, even with awkward text', () => {
  const s = B.create();
  B.add(s, { date: '2026-03-01', type: 'expense', cents: 1999, category: 'Food, drink', note: 'He said "yes"\nthen left' });
  B.add(s, { date: '2026-03-02', type: 'income', cents: 5, category: 'Salary', note: '' });
  const csv = B.toCSV(s);
  const back = B.create();
  const r = B.fromCSV(back, csv);
  assert.deepStrictEqual(r, { added: 2, errors: [] });
  assert.deepStrictEqual(back.tx.map((t) => [t.date, t.type, t.cents, t.category, t.note]), s.tx.map((t) => [t.date, t.type, t.cents, t.category, t.note]));
});

test('text that a spreadsheet would run as a formula is defused on the way out and restored on the way in', () => {
  const s = B.create();
  B.add(s, { date: '2026-03-01', type: 'expense', cents: 100, category: '=HYPERLINK("http://evil")', note: '+1+1' });
  const csv = B.toCSV(s);
  assert.ok(!/(^|,)=HYPERLINK/.test(csv), csv);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes(",'+1+1"));
  const back = B.create(); B.fromCSV(back, csv);
  assert.strictEqual(back.tx[0].category, '=HYPERLINK("http://evil")');
  assert.strictEqual(back.tx[0].note, '+1+1');
});

test('importing keeps the good rows and says which bad ones it skipped', () => {
  const s = B.create();
  const r = B.fromCSV(s, 'date,type,category,amount,note\n2026-03-01,expense,Food,12.50,ok\nnot-a-date,expense,Food,1,x\n2026-03-02,expense,Food,abc,x\n2026-03-03,income,Pay,100,');
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.errors.length, 2);
  assert.match(r.errors[0], /Line 3/);
  assert.strictEqual(B.fromCSV(B.create(), 'a,b,c').added, 0);
});

test('windows line endings and a byte-order mark are fine', () => {
  const s = B.create();
  const r = B.fromCSV(s, '\uFEFFdate,type,category,amount,note\r\n2026-03-01,expense,Food,3.00,\r\n');
  assert.strictEqual(r.added, 1);
});
done();
`;

const BUDGET_UI = String.raw`(function () {
  'use strict';
  var B = window.Budget, kit = window.kit;
  var state = kit.load('state', null) || B.create();
  var ym = B.monthOf(kit.today());
  function save() { kit.save('state', state); }

  kit.$('date').value = kit.today();

  function render() {
    var sum = B.summary(state, ym);
    kit.$('month').textContent = ym;
    kit.stats([['Income', B.format(sum.income)], ['Spent', B.format(sum.expense)], ['Left', B.format(sum.net)], ['Balance', B.format(B.balance(state))]]);

    var cats = kit.$('cats'); cats.textContent = '';
    if (!sum.byCategory.length) cats.appendChild(kit.el('p', 'hint', 'No spending this month yet.'));
    var status = {}; B.budgetStatus(state, ym).forEach(function (b) { status[b.category] = b; });
    sum.byCategory.forEach(function (c) {
      var st = status[c.category], row = kit.el('div', 'crow');
      var head = kit.el('div', 'chead'); head.appendChild(kit.el('span', '', c.category)); head.appendChild(kit.el('strong', st && st.over ? 'bad' : '', B.format(c.cents) + (st ? ' / ' + B.format(st.limit) : '')));
      var bar = kit.el('div', 'cbar'), fill = kit.el('div', 'cfill' + (st && st.over ? ' over' : ''));
      fill.style.width = Math.min(100, (st ? st.pct : c.share) * 100).toFixed(1) + '%'; bar.appendChild(fill);
      var set = kit.el('button', 'btn small', st ? 'Change limit' : 'Set limit'); set.type = 'button';
      set.addEventListener('click', function () {
        var v = window.prompt('Monthly limit for ' + c.category + ' (blank to remove):', st ? (st.limit / 100).toFixed(2) : '');
        if (v === null) return;
        var cents = v.trim() === '' ? 0 : B.parseMoney(v);
        if (cents === null) { kit.toast('Enter an amount like 250 or 250.00'); return; }
        B.setBudget(state, c.category, cents); save(); render();
      });
      row.appendChild(head); row.appendChild(bar); row.appendChild(set); cats.appendChild(row);
    });

    var table = kit.$('tx'); table.textContent = '';
    B.inMonth(state, ym).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id; }).forEach(function (t) {
      var tr = kit.el('tr');
      tr.appendChild(kit.el('td', 'dim', t.date.slice(5)));
      tr.appendChild(kit.el('td', '', t.category + (t.note ? ' - ' + t.note : '')));
      tr.appendChild(kit.el('td', 'amt ' + (t.type === 'income' ? 'good' : ''), (t.type === 'income' ? '+' : '-') + B.format(t.cents)));
      var td = kit.el('td'), del = kit.el('button', 'btn small danger', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Delete');
      del.addEventListener('click', function () { B.remove(state, t.id); save(); render(); });
      td.appendChild(del); tr.appendChild(td); table.appendChild(tr);
    });

    var dl = kit.$('catlist'); dl.textContent = '';
    var seen = {}; state.tx.forEach(function (t) { seen[t.category] = true; });
    Object.keys(seen).sort().forEach(function (c) { var o = kit.el('option'); o.value = c; dl.appendChild(o); });
    chart();
  }

  function chart() {
    var c = kit.$('chart'), ctx = c.getContext('2d'), data = B.series(state, ym, 6);
    var w = c.width, h = c.height, max = Math.max(1, Math.max.apply(null, data.map(function (d) { return Math.max(d.income, d.expense); })));
    ctx.clearRect(0, 0, w, h);
    var slot = w / data.length;
    data.forEach(function (d, i) {
      var bw = slot * 0.28, x = i * slot + slot * 0.14;
      ctx.fillStyle = '#34d399'; var hi = d.income / max * (h - 30); ctx.fillRect(x, h - 18 - hi, bw, hi);
      ctx.fillStyle = '#a855f7'; var he = d.expense / max * (h - 30); ctx.fillRect(x + bw + 4, h - 18 - he, bw, he);
      ctx.fillStyle = '#9a8cb8'; ctx.font = '11px Segoe UI'; ctx.textAlign = 'center'; ctx.fillText(d.ym.slice(2), i * slot + slot / 2, h - 4);
    });
  }

  kit.$('add').addEventListener('submit', function (e) {
    e.preventDefault();
    var cents = B.parseMoney(kit.$('amount').value);
    if (cents === null) { kit.toast('Enter an amount like 12.50'); return; }
    try {
      B.add(state, { date: kit.$('date').value, type: kit.$('type').value, cents: cents, category: kit.$('cat').value, note: kit.$('note').value });
      ym = B.monthOf(kit.$('date').value);
      kit.$('amount').value = ''; kit.$('note').value = ''; save(); render(); kit.$('amount').focus();
    } catch (err) { kit.toast(err.message); }
  });
  kit.$('prev').addEventListener('click', function () { ym = B.addMonths(ym, -1); render(); });
  kit.$('next').addEventListener('click', function () { ym = B.addMonths(ym, 1); render(); });
  kit.$('export').addEventListener('click', function () { kit.download('budget.csv', B.toCSV(state), 'text/csv'); });
  kit.$('import').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { var r = B.fromCSV(state, String(reader.result)); save(); render(); kit.toast('Imported ' + r.added + ' entries' + (r.errors.length ? ', skipped ' + r.errors.length : '') + '.'); };
    reader.readAsText(f); e.target.value = '';
  });
  render();
})();
`;

export const budgetApp = webApp({
  id: 'budget',
  label: 'a budget tracker',
  summary: 'a budget tracker: income and spending in whole cents, categories, monthly limits, a six-month chart and CSV import and export',
  group: 'tool',
  words: ['budget tracker', 'budget app', 'expense tracker', 'expenses app', 'money tracker', 'finance tracker', 'spending tracker'],
  size: [1000, 800],
  wide: true,
  body: `      <div class="bud">
        <form id="add" class="card addrow"><input id="date" type="date" aria-label="Date"><select id="type" aria-label="Type"><option value="expense">Expense</option><option value="income">Income</option></select><input id="amount" inputmode="decimal" placeholder="Amount" autocomplete="off" aria-label="Amount"><input id="cat" list="catlist" placeholder="Category" aria-label="Category"><datalist id="catlist"></datalist><input id="note" placeholder="Note (optional)" aria-label="Note"><button class="btn primary" type="submit">Add</button></form>
        <div class="grid2">
          <section class="card"><div class="row"><button class="btn small" id="prev" type="button">&lt;</button><h2 id="month" class="flush"></h2><button class="btn small" id="next" type="button">&gt;</button></div><div id="cats" class="cats"></div></section>
          <section class="card"><h2>Last six months</h2><canvas id="chart" width="440" height="190"></canvas><p class="hint"><span class="good">green</span> money in, <span class="accent">purple</span> money out</p></section>
        </div>
        <section class="card"><table class="txt"><tbody id="tx"></tbody></table></section>
        <div class="row"><button class="btn small" id="export" type="button">Export CSV</button><label class="btn small">Import CSV<input id="import" type="file" accept=".csv,text/csv" hidden></label></div>
      </div>`,
  css: `
.bud { width: min(100%, 960px); margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.flush { margin: 0; } .accent { color: var(--purple); }
.addrow { display: flex; gap: 8px; flex-wrap: wrap; } .addrow input[type="date"] { width: 150px; } .addrow input { flex: 1; min-width: 110px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
.cats { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.crow { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; } .chead { display: flex; justify-content: space-between; grid-column: 1; } .crow .cbar { grid-column: 1; } .crow .btn { grid-row: 1 / span 2; grid-column: 2; }
.cbar { height: 8px; background: var(--bg2); border-radius: 999px; border: 1px solid var(--line); overflow: hidden; } .cfill { height: 100%; background: var(--purple); border-radius: 999px; } .cfill.over { background: var(--bad); }
.txt { width: 100%; border-collapse: collapse; } .txt td { padding: 7px 8px; border-bottom: 1px solid var(--line); } .amt { text-align: right; font-variant-numeric: tabular-nums; } .txt td:last-child { width: 40px; }
canvas { width: 100%; height: auto; }
`,
  logic: BUDGET_LOGIC,
  ui: BUDGET_UI,
  test: BUDGET_TEST,
});

// ------------------------------------------------------------------------------------ HABITS

const HABITS_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a habit tracker. Pure logic. Dates are 'YYYY-MM-DD' strings and all date
 * arithmetic is done in UTC, so a daylight-saving change can never break (or invent) a streak.
 */
(function (root) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function parseISO(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function toISO(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * 86400000); }
  function dayOfWeek(iso) { return (new Date(parseISO(iso)).getUTCDay() + 6) % 7; }     // Monday = 0
  function diff(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }

  function create() { return { habits: [], nextId: 1 }; }

  function add(s, name, today) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return null;
    var h = { id: s.nextId++, name: name, created: today, done: {} };
    s.habits.push(h); return h;
  }
  function get(s, id) { for (var i = 0; i < s.habits.length; i++) if (s.habits[i].id === id) return s.habits[i]; return null; }
  function remove(s, id) { var n = s.habits.length; s.habits = s.habits.filter(function (h) { return h.id !== id; }); return n !== s.habits.length; }
  function toggle(s, id, date) {
    var h = get(s, id); if (!h) return null;
    if (h.done[date]) delete h.done[date]; else h.done[date] = true;
    return !!h.done[date];
  }

  // The current streak counts back from today; if today is not done YET it counts from yesterday, so
  // a streak is not shown as lost until a whole day has actually been missed.
  function streaks(h, today) {
    var d = h.done[today] ? today : addDays(today, -1), current = 0;
    while (h.done[d]) { current++; d = addDays(d, -1); }
    var dates = Object.keys(h.done).sort(), longest = 0, run = 0, prev = null;
    dates.forEach(function (x) {
      run = prev && diff(prev, x) === 1 ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = x;
    });
    return { current: current, longest: longest };
  }

  // The share of the last n days (not counting days before the habit existed) that were done.
  function rate(h, today, n) {
    var start = addDays(today, -(n - 1));
    if (start < h.created) start = h.created;
    var days = diff(start, today) + 1;
    if (days <= 0) return 0;
    var done = 0;
    for (var i = 0; i < days; i++) if (h.done[addDays(start, i)]) done++;
    return done / days;
  }

  // weeks columns of 7 days (Monday first), ending with the week that holds today.
  function grid(h, today, weeks) {
    var endMonday = addDays(today, -dayOfWeek(today)), first = addDays(endMonday, -7 * (weeks - 1)), cols = [];
    for (var w = 0; w < weeks; w++) {
      var col = [];
      for (var d = 0; d < 7; d++) { var date = addDays(first, w * 7 + d); col.push({ date: date, done: !!h.done[date], future: date > today }); }
      cols.push(col);
    }
    return cols;
  }

  function doneToday(s, today) { return s.habits.filter(function (h) { return h.done[today]; }).length; }

  var api = { create: create, add: add, get: get, remove: remove, toggle: toggle, streaks: streaks, rate: rate, grid: grid, doneToday: doneToday, addDays: addDays, diff: diff, dayOfWeek: dayOfWeek };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Habits = api;
})(typeof window !== 'undefined' ? window : this);
`;

const HABITS_TEST = String.raw`
const H = require('./logic.js');

function habitWith(days, created) { const s = H.create(); const h = H.add(s, 'read', created || '2020-01-01'); days.forEach((d) => H.toggle(s, h.id, d)); return h; }

test('a streak counts the days in a row ending today', () => {
  const h = habitWith(['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.deepStrictEqual(H.streaks(h, '2026-10-07'), { current: 3, longest: 3 });
});

test("a streak is not lost until a whole day is actually missed", () => {
  const h = habitWith(['2026-10-05', '2026-10-06']);
  assert.strictEqual(H.streaks(h, '2026-10-07').current, 2, 'today is not done yet, but yesterday was');
  assert.strictEqual(H.streaks(h, '2026-10-08').current, 0, 'a full day was missed');
});

test('a gap ends the streak but the longest one is remembered', () => {
  const h = habitWith(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-07']);
  assert.deepStrictEqual(H.streaks(h, '2026-10-07'), { current: 2, longest: 4 });
});

test('streaks run across month ends, year ends and leap days', () => {
  assert.strictEqual(H.streaks(habitWith(['2026-10-30', '2026-10-31', '2026-11-01']), '2026-11-01').current, 3);
  assert.strictEqual(H.streaks(habitWith(['2026-12-31', '2027-01-01']), '2027-01-01').current, 2);
  assert.strictEqual(H.streaks(habitWith(['2028-02-28', '2028-02-29', '2028-03-01']), '2028-03-01').current, 3);
  assert.strictEqual(H.streaks(habitWith(['2027-02-28', '2027-03-01']), '2027-03-01').current, 2);
});

test('daylight-saving changes cannot break a streak', () => {
  // the clocks change on these dates in many countries
  const h = habitWith(['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26']);
  assert.strictEqual(H.streaks(h, '2026-03-30').current, 3);
  assert.strictEqual(H.streaks(h, '2026-10-26').current, 3);
});

test('a habit with no days done has no streak', () => {
  assert.deepStrictEqual(H.streaks(habitWith([]), '2026-10-07'), { current: 0, longest: 0 });
});

test('ticking twice unticks', () => {
  const s = H.create(); const h = H.add(s, 'run', '2026-10-01');
  assert.strictEqual(H.toggle(s, h.id, '2026-10-02'), true);
  assert.strictEqual(H.toggle(s, h.id, '2026-10-02'), false);
  assert.strictEqual(H.toggle(s, 99, '2026-10-02'), null);
});

test('the completion rate only counts days since the habit began', () => {
  const h = habitWith(['2026-10-05', '2026-10-06', '2026-10-07'], '2026-10-04');
  assert.ok(Math.abs(H.rate(h, '2026-10-07', 30) - 3 / 4) < 1e-12, 'four days old, three done');
  assert.ok(Math.abs(H.rate(habitWith(['2026-10-07'], '2020-01-01'), '2026-10-07', 7) - 1 / 7) < 1e-12);
});

test('the heat map is whole weeks, Monday first, ending with this week', () => {
  const h = habitWith(['2026-10-07']);                        // a Wednesday
  const g = H.grid(h, '2026-10-07', 12);
  assert.strictEqual(g.length, 12);
  g.forEach((col) => assert.strictEqual(col.length, 7));
  assert.strictEqual(g[11][0].date, '2026-10-05', 'the last column starts on that Monday');
  assert.strictEqual(g[11][2].done, true);
  assert.strictEqual(g[11][3].future, true);
  assert.strictEqual(H.dayOfWeek('2026-10-05'), 0);
  assert.strictEqual(H.dayOfWeek('2026-10-11'), 6);
});

test('habits are added with a trimmed name, counted, and removed', () => {
  const s = H.create();
  assert.strictEqual(H.add(s, '   ', '2026-10-07'), null);
  const a = H.add(s, '  stretch  ', '2026-10-07'); H.add(s, 'water', '2026-10-07');
  assert.strictEqual(a.name, 'stretch');
  H.toggle(s, a.id, '2026-10-07');
  assert.strictEqual(H.doneToday(s, '2026-10-07'), 1);
  assert.strictEqual(H.remove(s, a.id), true);
  assert.strictEqual(s.habits.length, 1);
});
done();
`;

const HABITS_UI = String.raw`(function () {
  'use strict';
  var H = window.Habits, kit = window.kit;
  var state = kit.load('state', null) || H.create();
  var list = kit.$('habits');
  function save() { kit.save('state', state); }

  function render() {
    var today = kit.today();
    list.textContent = '';
    if (!state.habits.length) list.appendChild(kit.el('p', 'hint', 'No habits yet. Add one above, like "Read 20 minutes".'));
    var best = 0;
    state.habits.forEach(function (h) {
      var st = H.streaks(h, today); best = Math.max(best, st.longest);
      var card = kit.el('div', 'card habit');
      var top = kit.el('div', 'htop');
      var check = kit.el('button', 'tick' + (h.done[today] ? ' on' : ''), h.done[today] ? 'Done' : 'Mark done'); check.type = 'button';
      check.addEventListener('click', function () { H.toggle(state, h.id, today); save(); render(); });
      var name = kit.el('div', 'hname'); name.appendChild(kit.el('strong', '', h.name));
      name.appendChild(kit.el('span', 'dim', st.current + ' day streak - best ' + st.longest + ' - ' + Math.round(H.rate(h, today, 30) * 100) + '% of the last 30 days'));
      var del = kit.el('button', 'btn small danger', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Delete ' + h.name);
      del.addEventListener('click', function () { if (window.confirm('Delete "' + h.name + '" and its history?')) { H.remove(state, h.id); save(); render(); } });
      top.appendChild(check); top.appendChild(name); top.appendChild(del);
      var heat = kit.el('div', 'heat');
      H.grid(h, today, 20).forEach(function (col) {
        var c = kit.el('div', 'hcol');
        col.forEach(function (d) {
          var cell = kit.el('button', 'hcell' + (d.done ? ' on' : '') + (d.future ? ' future' : '')); cell.type = 'button';
          cell.title = d.date + (d.done ? ' - done' : ''); cell.disabled = d.future;
          cell.addEventListener('click', function () { H.toggle(state, h.id, d.date); save(); render(); });
          c.appendChild(cell);
        });
        heat.appendChild(c);
      });
      card.appendChild(top); card.appendChild(heat); list.appendChild(card);
    });
    kit.stats([['Today', H.doneToday(state, today) + '/' + state.habits.length], ['Best streak', best]]);
  }

  kit.$('add').addEventListener('submit', function (e) {
    e.preventDefault();
    if (H.add(state, kit.$('new').value, kit.today())) { kit.$('new').value = ''; save(); render(); }
  });
  render();
})();
`;

export const habitsApp = webApp({
  id: 'habits',
  label: 'a habit tracker',
  summary: 'a habit tracker with streaks, a longest streak, completion rates and a 20-week heat map for each habit',
  group: 'tool',
  words: ['habit tracker', 'habit app', 'habits app', 'streak tracker'],
  size: [860, 780],
  wide: true,
  body: `      <div class="hab">
        <form id="add" class="row"><input id="new" placeholder="New habit, e.g. Read 20 minutes" autocomplete="off" aria-label="New habit"><button class="btn primary" type="submit">Add</button></form>
        <div id="habits" class="hlist"></div>
        <p class="hint">Click a square to mark or unmark that day. Your streak is kept until a whole day is missed.</p>
      </div>`,
  css: `
.hab { width: min(100%, 760px); margin: 0 auto; display: flex; flex-direction: column; gap: 12px; } .hab form input { flex: 1; min-width: 200px; }
.hlist { display: flex; flex-direction: column; gap: 12px; }
.htop { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .hname { flex: 1; min-width: 160px; display: flex; flex-direction: column; } .hname span { font-size: 13px; }
.tick { padding: 8px 16px; border-radius: 9px; border: 1px solid var(--purple2); background: transparent; color: var(--text); font: inherit; cursor: pointer; min-width: 96px; }
.tick.on { background: var(--purple2); border-color: var(--purple); }
.heat { display: flex; gap: 3px; margin-top: 12px; overflow-x: auto; } .hcol { display: flex; flex-direction: column; gap: 3px; }
.hcell { width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px; background: #1a1030; cursor: pointer; } .hcell.on { background: var(--purple); box-shadow: 0 0 6px var(--glow); } .hcell.future { opacity: 0.25; cursor: default; }
`,
  logic: HABITS_LOGIC,
  ui: HABITS_UI,
  test: HABITS_TEST,
});

// ------------------------------------------------------------------------------------ KANBAN

const KANBAN_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a Kanban board: columns holding cards that move between them. Pure logic.
 * The one rule worth knowing: moveCard's index is the card's FINAL position in the target column.
 */
(function (root) {
  'use strict';

  function create() {
    return { columns: [{ id: 1, title: 'To do', cards: [] }, { id: 2, title: 'Doing', cards: [] }, { id: 3, title: 'Done', cards: [] }], nextColumn: 4, nextCard: 1 };
  }

  function column(b, id) { for (var i = 0; i < b.columns.length; i++) if (b.columns[i].id === id) return b.columns[i]; return null; }

  // { column, index, card } for a card id, or null.
  function find(b, cardId) {
    for (var c = 0; c < b.columns.length; c++) {
      var cards = b.columns[c].cards;
      for (var i = 0; i < cards.length; i++) if (cards[i].id === cardId) return { column: b.columns[c], index: i, card: cards[i] };
    }
    return null;
  }

  function addCard(b, columnId, title, now) {
    var col = column(b, columnId); title = String(title || '').trim().slice(0, 200);
    if (!col || !title) return null;
    var card = { id: b.nextCard++, title: title, notes: '', created: now || 0 };
    col.cards.push(card); return card;
  }

  function editCard(b, cardId, patch) {
    var f = find(b, cardId); if (!f) return null;
    if (patch.title !== undefined) { var t = String(patch.title).trim().slice(0, 200); if (t) f.card.title = t; }
    if (patch.notes !== undefined) f.card.notes = String(patch.notes).slice(0, 2000);
    return f.card;
  }

  function removeCard(b, cardId) {
    var f = find(b, cardId); if (!f) return null;
    f.column.cards.splice(f.index, 1);
    return { card: f.card, columnId: f.column.id, index: f.index };
  }
  function restoreCard(b, removed) { var col = column(b, removed.columnId); if (col) col.cards.splice(Math.min(removed.index, col.cards.length), 0, removed.card); }

  function moveCard(b, cardId, toColumnId, index) {
    var to = column(b, toColumnId), f = find(b, cardId);
    if (!to || !f) return false;
    f.column.cards.splice(f.index, 1);
    var at = Math.max(0, Math.min(index === undefined ? to.cards.length : index, to.cards.length));
    to.cards.splice(at, 0, f.card);
    return true;
  }

  // Step a card to the neighbouring column (-1 left, +1 right), landing at the top.
  function nudge(b, cardId, dir) {
    var f = find(b, cardId); if (!f) return false;
    var at = b.columns.indexOf(f.column) + dir;
    if (at < 0 || at >= b.columns.length) return false;
    return moveCard(b, cardId, b.columns[at].id, 0);
  }

  function addColumn(b, title) {
    title = String(title || '').trim().slice(0, 40);
    if (!title || b.columns.length >= 8) return null;
    var col = { id: b.nextColumn++, title: title, cards: [] }; b.columns.push(col); return col;
  }
  function renameColumn(b, id, title) { var c = column(b, id); title = String(title || '').trim().slice(0, 40); if (!c || !title) return false; c.title = title; return true; }

  // A column that still has cards is never deleted: that would lose work silently.
  function removeColumn(b, id) {
    var c = column(b, id); if (!c) return { ok: false, reason: 'No such column' };
    if (c.cards.length) return { ok: false, reason: 'Move or delete its ' + c.cards.length + ' card' + (c.cards.length === 1 ? '' : 's') + ' first' };
    if (b.columns.length <= 1) return { ok: false, reason: 'A board needs at least one column' };
    b.columns.splice(b.columns.indexOf(c), 1); return { ok: true };
  }

  function moveColumn(b, id, toIndex) {
    var c = column(b, id); if (!c) return false;
    b.columns.splice(b.columns.indexOf(c), 1);
    b.columns.splice(Math.max(0, Math.min(toIndex, b.columns.length)), 0, c); return true;
  }

  function counts(b) {
    var total = 0; b.columns.forEach(function (c) { total += c.cards.length; });
    var last = b.columns[b.columns.length - 1];
    return { total: total, done: last && b.columns.length > 1 ? last.cards.length : 0, columns: b.columns.length };
  }

  var api = { create: create, column: column, find: find, addCard: addCard, editCard: editCard, removeCard: removeCard, restoreCard: restoreCard, moveCard: moveCard, nudge: nudge,
    addColumn: addColumn, renameColumn: renameColumn, removeColumn: removeColumn, moveColumn: moveColumn, counts: counts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Kanban = api;
})(typeof window !== 'undefined' ? window : this);
`;

const KANBAN_TEST = String.raw`
const K = require('./logic.js');
const titles = (b, id) => K.column(b, id).cards.map((c) => c.title);

function board() {
  const b = K.create();
  ['a', 'b', 'c'].forEach((t) => K.addCard(b, 1, t));
  K.addCard(b, 2, 'x');
  return b;
}

test('a new board has three columns, and cards go on the end', () => {
  const b = board();
  assert.deepStrictEqual(b.columns.map((c) => c.title), ['To do', 'Doing', 'Done']);
  assert.deepStrictEqual(titles(b, 1), ['a', 'b', 'c']);
});

test('blank cards and unknown columns are refused', () => {
  const b = K.create();
  assert.strictEqual(K.addCard(b, 1, '   '), null);
  assert.strictEqual(K.addCard(b, 99, 'x'), null);
});

test('a card moves to another column at the place asked for', () => {
  const b = board();
  K.moveCard(b, K.column(b, 1).cards[1].id, 2, 0);
  assert.deepStrictEqual(titles(b, 1), ['a', 'c']);
  assert.deepStrictEqual(titles(b, 2), ['b', 'x']);
});

test('moving inside a column puts the card exactly where you said, up or down', () => {
  const b = board();
  const idOf = (t) => K.column(b, 1).cards.find((c) => c.title === t).id;
  K.moveCard(b, idOf('a'), 1, 2);
  assert.deepStrictEqual(titles(b, 1), ['b', 'c', 'a']);
  K.moveCard(b, idOf('a'), 1, 0);
  assert.deepStrictEqual(titles(b, 1), ['a', 'b', 'c']);
  K.moveCard(b, idOf('b'), 1, 1);
  assert.deepStrictEqual(titles(b, 1), ['a', 'b', 'c']);
});

test('an index that is too big or too small is kept inside the column', () => {
  const b = board();
  const a = K.column(b, 1).cards[0].id;
  K.moveCard(b, a, 2, 99);
  assert.deepStrictEqual(titles(b, 2), ['x', 'a']);
  K.moveCard(b, a, 2, -5);
  assert.deepStrictEqual(titles(b, 2), ['a', 'x']);
});

test('moving to no particular place goes to the bottom', () => {
  const b = board();
  K.moveCard(b, K.column(b, 1).cards[0].id, 2);
  assert.deepStrictEqual(titles(b, 2), ['x', 'a']);
});

test('no card is ever lost or duplicated by moves', () => {
  const b = board(); const rng = seeded(5);
  for (let i = 0; i < 500; i++) {
    const all = b.columns.flatMap((c) => c.cards);
    const card = all[Math.floor(rng() * all.length)];
    K.moveCard(b, card.id, b.columns[Math.floor(rng() * 3)].id, Math.floor(rng() * 6) - 1);
    const ids = b.columns.flatMap((c) => c.cards.map((x) => x.id)).sort((x, y) => x - y);
    assert.deepStrictEqual(ids, all.map((c) => c.id).sort((x, y) => x - y));
  }
});

test('nudging steps a card to the next column, and stops at the ends', () => {
  const b = board();
  const a = K.column(b, 1).cards[0].id;
  assert.strictEqual(K.nudge(b, a, -1), false);
  assert.strictEqual(K.nudge(b, a, 1), true);
  assert.strictEqual(K.find(b, a).column.id, 2);
  K.nudge(b, a, 1);
  assert.strictEqual(K.nudge(b, a, 1), false);
});

test('editing a card changes its text, but never to nothing', () => {
  const b = board(); const id = K.column(b, 1).cards[0].id;
  K.editCard(b, id, { title: 'renamed', notes: 'details' });
  assert.strictEqual(K.find(b, id).card.title, 'renamed');
  K.editCard(b, id, { title: '   ' });
  assert.strictEqual(K.find(b, id).card.title, 'renamed');
  assert.strictEqual(K.find(b, id).card.notes, 'details');
});

test('a deleted card can be brought back where it was', () => {
  const b = board(); const id = K.column(b, 1).cards[1].id;
  const gone = K.removeCard(b, id);
  assert.deepStrictEqual(titles(b, 1), ['a', 'c']);
  K.restoreCard(b, gone);
  assert.deepStrictEqual(titles(b, 1), ['a', 'b', 'c']);
});

test('columns: add, rename, reorder, and never delete one that still has cards', () => {
  const b = board();
  const col = K.addColumn(b, 'Review');
  assert.strictEqual(b.columns.length, 4);
  K.renameColumn(b, col.id, 'In review');
  K.moveColumn(b, col.id, 1);
  assert.deepStrictEqual(b.columns.map((c) => c.title), ['To do', 'In review', 'Doing', 'Done']);
  assert.deepStrictEqual(K.removeColumn(b, 1), { ok: false, reason: 'Move or delete its 3 cards first' });
  assert.deepStrictEqual(K.removeColumn(b, col.id), { ok: true });
  assert.strictEqual(K.addColumn(b, '  '), null);
});

test('there is a limit of eight columns, and a board keeps at least one', () => {
  const b = K.create();
  while (K.addColumn(b, 'c' + b.nextColumn)) { /* fill it */ }
  assert.strictEqual(b.columns.length, 8);
  const one = K.create(); one.columns = [one.columns[0]];
  assert.strictEqual(K.removeColumn(one, 1).ok, false);
});

test('counts say how much is done', () => {
  const b = board(); K.moveCard(b, K.column(b, 1).cards[0].id, 3);
  assert.deepStrictEqual(K.counts(b), { total: 4, done: 1, columns: 3 });
});
done();
`;

const KANBAN_UI = String.raw`(function () {
  'use strict';
  var K = window.Kanban, kit = window.kit;
  var board = kit.load('board', null) || K.create();
  var dragging = null, undo = null;
  var host = kit.$('board');
  function save() { kit.save('board', board); }

  function render() {
    host.textContent = '';
    board.columns.forEach(function (col, ci) {
      var el = kit.el('section', 'col card'); el.dataset.id = col.id;
      var head = kit.el('div', 'colhead');
      var title = kit.el('input', 'coltitle'); title.value = col.title; title.setAttribute('aria-label', 'Column name');
      title.addEventListener('change', function () { K.renameColumn(board, col.id, title.value); save(); render(); });
      head.appendChild(title); head.appendChild(kit.el('span', 'dim', String(col.cards.length)));
      var rm = kit.el('button', 'btn small danger', 'x'); rm.type = 'button'; rm.setAttribute('aria-label', 'Delete column');
      rm.addEventListener('click', function () { var r = K.removeColumn(board, col.id); if (!r.ok) kit.toast(r.reason); save(); render(); });
      head.appendChild(rm); el.appendChild(head);

      var cards = kit.el('div', 'cards'); cards.dataset.id = col.id;
      cards.addEventListener('dragover', function (e) { e.preventDefault(); cards.classList.add('over'); });
      cards.addEventListener('dragleave', function () { cards.classList.remove('over'); });
      cards.addEventListener('drop', function (e) {
        e.preventDefault(); cards.classList.remove('over');
        if (!dragging) return;
        var kids = Array.prototype.filter.call(cards.children, function (c) { return c.classList.contains('kcard') && Number(c.dataset.id) !== dragging; });
        var at = kids.length;
        for (var i = 0; i < kids.length; i++) { var r = kids[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { at = i; break; } }
        K.moveCard(board, dragging, col.id, at); dragging = null; save(); render();
      });
      col.cards.forEach(function (card) {
        var k = kit.el('div', 'kcard'); k.draggable = true; k.dataset.id = card.id;
        k.addEventListener('dragstart', function (e) { dragging = card.id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(card.id)); } catch (x) { /* some browsers refuse */ } k.classList.add('drag'); });
        k.addEventListener('dragend', function () { k.classList.remove('drag'); });
        var text = kit.el('div', 'ktext', card.title); text.title = 'Double-click to edit';
        text.addEventListener('dblclick', function () { var v = window.prompt('Edit card', card.title); if (v !== null) { K.editCard(board, card.id, { title: v }); save(); render(); } });
        var tools = kit.el('div', 'ktools');
        [['<', -1, 'Move left'], ['>', 1, 'Move right']].forEach(function (b) {
          var btn = kit.el('button', 'btn small', b[0]); btn.type = 'button'; btn.setAttribute('aria-label', b[2]);
          btn.disabled = ci + b[1] < 0 || ci + b[1] >= board.columns.length;
          btn.addEventListener('click', function () { K.nudge(board, card.id, b[1]); save(); render(); });
          tools.appendChild(btn);
        });
        var del = kit.el('button', 'btn small danger', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Delete card');
        del.addEventListener('click', function () { undo = K.removeCard(board, card.id); save(); render(); kit.toast('Card deleted. Press Ctrl+Z to bring it back.'); });
        tools.appendChild(del); k.appendChild(text); k.appendChild(tools); cards.appendChild(k);
      });
      el.appendChild(cards);

      var form = kit.el('form', 'newcard'); var inp = kit.el('input'); inp.placeholder = 'Add a card'; inp.setAttribute('aria-label', 'Add a card to ' + col.title);
      form.appendChild(inp);
      form.addEventListener('submit', function (e) { e.preventDefault(); if (K.addCard(board, col.id, inp.value, Date.now())) { save(); render(); } });
      el.appendChild(form); host.appendChild(el);
    });
    var c = K.counts(board);
    kit.stats([['Cards', c.total], ['Done', c.done], ['Columns', c.columns]]);
  }

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undo && !kit.typing(e)) { e.preventDefault(); K.restoreCard(board, undo); undo = null; save(); render(); }
  });
  kit.$('addcol').addEventListener('click', function () { var v = window.prompt('Name for the new column:'); if (v && !K.addColumn(board, v)) kit.toast('A board can have at most 8 columns.'); save(); render(); });
  render();
})();
`;

export const kanbanApp = webApp({
  id: 'kanban',
  label: 'a kanban board',
  summary: 'a Kanban board: columns and cards you drag between them, with undo for deleted cards',
  group: 'tool',
  words: ['kanban', 'kanban board', 'task board', 'trello', 'project board', 'scrum board'],
  size: [1180, 780],
  wide: true,
  body: `      <div class="row left"><button class="btn small" id="addcol" type="button">Add column</button><span class="hint">Drag cards between columns, or use the arrows. Double-click a card to edit it.</span></div>
      <div id="board" class="kboard"></div>`,
  css: `
.kboard { display: flex; gap: 14px; align-items: flex-start; overflow-x: auto; padding-bottom: 12px; flex: 1; }
.left { justify-content: flex-start; }
.col { width: 270px; flex: 0 0 270px; display: flex; flex-direction: column; gap: 10px; }
.colhead { display: flex; align-items: center; gap: 8px; } .coltitle { flex: 1; min-width: 0; background: transparent; border-color: transparent; font-weight: 700; color: var(--purple); } .coltitle:hover, .coltitle:focus { border-color: var(--line); }
.cards { display: flex; flex-direction: column; gap: 8px; min-height: 40px; padding: 4px; border-radius: 10px; border: 1px dashed transparent; } .cards.over { border-color: var(--purple2); background: rgba(124, 58, 237, 0.08); }
.kcard { background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; cursor: grab; } .kcard.drag { opacity: 0.4; } .kcard:hover { border-color: var(--purple2); }
.ktext { overflow-wrap: anywhere; } .ktools { display: flex; gap: 4px; justify-content: flex-end; margin-top: 6px; opacity: 0.55; } .kcard:hover .ktools, .kcard:focus-within .ktools { opacity: 1; }
.newcard input { width: 100%; }
`,
  logic: KANBAN_LOGIC,
  ui: KANBAN_UI,
  test: KANBAN_TEST,
});

// ------------------------------------------------------------------------------------ FLASHCARDS

const FLASH_LOGIC = String.raw`/*
 * {{NAME}} - flashcards with spaced repetition (the SM-2 method, from SuperMemo). A card you know
 * well comes back after longer and longer gaps; one you forget comes back soon. Pure logic; dates
 * are 'YYYY-MM-DD' strings and date arithmetic is done in UTC.
 *
 *   interval  1 day after the first success, 6 after the second, then (last interval x ease)
 *   ease      starts at 2.5 and moves with how easy each answer felt, never below 1.3
 *   a failed answer starts the card over (interval 1 day) but keeps its ease
 */
(function (root) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function parseISO(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function toISO(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * 86400000); }

  // The four buttons, and the SM-2 quality (0-5) each stands for.
  var GRADES = { again: 1, hard: 3, good: 4, easy: 5 };

  function create() { return { cards: [], nextId: 1 }; }

  function add(s, front, back, today) {
    front = String(front || '').trim().slice(0, 500); back = String(back || '').trim().slice(0, 1000);
    if (!front || !back) return null;
    var c = { id: s.nextId++, front: front, back: back, ease: 2.5, reps: 0, interval: 0, due: today, lapses: 0, seen: 0 };
    s.cards.push(c); return c;
  }

  // What reviewing would do, without doing it. Returns the new { ease, reps, interval, lapses }.
  function schedule(card, grade) {
    var q = GRADES[grade];
    if (q === undefined) throw new Error('Unknown grade');
    var ease = card.ease, reps = card.reps, interval, lapses = card.lapses;
    if (q < 3) { reps = 0; interval = 1; lapses += 1; }
    else {
      interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(card.interval * ease);
      reps += 1;
      ease = Math.max(1.3, ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    }
    return { ease: ease, reps: reps, interval: interval, lapses: lapses };
  }

  function review(card, grade, today) {
    var r = schedule(card, grade);
    card.ease = r.ease; card.reps = r.reps; card.interval = r.interval; card.lapses = r.lapses;
    card.due = addDays(today, r.interval); card.seen += 1;
    return card;
  }

  // Due cards, the most overdue first. New cards (never seen) come after the due ones, up to a limit.
  function queue(s, today, newLimit) {
    var due = s.cards.filter(function (c) { return c.seen > 0 && c.due <= today; });
    due.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id; });
    var fresh = s.cards.filter(function (c) { return c.seen === 0; }).slice(0, newLimit === undefined ? 10 : newLimit);
    return due.concat(fresh);
  }

  function stats(s, today) {
    var out = { total: s.cards.length, due: 0, fresh: 0, learning: 0, mature: 0 };
    s.cards.forEach(function (c) {
      if (c.seen === 0) out.fresh++;
      else {
        if (c.due <= today) out.due++;
        if (c.interval >= 21) out.mature++; else out.learning++;
      }
    });
    return out;
  }

  // "front :: back" lines -> cards. Returns how many were added and which lines were skipped.
  function importText(s, text, today) {
    var added = 0, skipped = [];
    String(text).split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var at = line.indexOf('::');
      if (at < 0 || !add(s, line.slice(0, at), line.slice(at + 2), today)) skipped.push(i + 1); else added++;
    });
    return { added: added, skipped: skipped };
  }

  function exportText(s) { return s.cards.map(function (c) { return c.front + ' :: ' + c.back; }).join('\n') + '\n'; }
  function remove(s, id) { var n = s.cards.length; s.cards = s.cards.filter(function (c) { return c.id !== id; }); return n !== s.cards.length; }

  // "1 day", "6 days", "3 weeks", "2 months" for the button labels.
  function describeInterval(days) {
    if (days < 1) return 'today';
    if (days === 1) return '1 day';
    if (days < 14) return days + ' days';
    if (days < 60) return Math.round(days / 7) + ' weeks';
    if (days < 365) return Math.round(days / 30) + ' months';
    return (Math.round(days / 36.5) / 10) + ' years';
  }

  var api = { GRADES: GRADES, create: create, add: add, schedule: schedule, review: review, queue: queue, stats: stats, importText: importText, exportText: exportText, remove: remove, describeInterval: describeInterval, addDays: addDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Flashcards = api;
})(typeof window !== 'undefined' ? window : this);
`;

const FLASH_TEST = String.raw`
const F = require('./logic.js');
const TODAY = '2026-10-07';
const fresh = () => { const s = F.create(); return { s, c: F.add(s, 'front', 'back', TODAY) }; };

test('a new card starts with ease 2.5 and is due now', () => {
  const { c } = fresh();
  assert.deepStrictEqual([c.ease, c.reps, c.interval, c.due, c.seen], [2.5, 0, 0, TODAY, 0]);
});

test('the first good answers give intervals of 1 day, 6 days, then 6 x ease', () => {
  const { c } = fresh();
  F.review(c, 'good', TODAY);               assert.strictEqual(c.interval, 1);  assert.strictEqual(c.due, '2026-10-08');
  F.review(c, 'good', '2026-10-08');        assert.strictEqual(c.interval, 6);  assert.strictEqual(c.due, '2026-10-14');
  F.review(c, 'good', '2026-10-14');        assert.strictEqual(c.interval, 15); // round(6 * 2.5)
  F.review(c, 'good', '2026-10-29');        assert.strictEqual(c.interval, 38); // round(15 * 2.5)
});

test('ease moves with how easy the answers were, exactly as SM-2 says', () => {
  const eased = (g) => { const { c } = fresh(); F.review(c, g, TODAY); return c.ease; };
  assert.ok(Math.abs(eased('easy') - 2.6) < 1e-12);         // +0.10
  assert.ok(Math.abs(eased('good') - 2.5) < 1e-12);         // +0.00
  assert.ok(Math.abs(eased('hard') - 2.36) < 1e-12);        // -0.14
});

test('ease never falls below 1.3 however many times it is hard', () => {
  const { c } = fresh();
  for (let i = 0; i < 40; i++) F.review(c, 'hard', TODAY);
  assert.ok(Math.abs(c.ease - 1.3) < 1e-12);
});

test('forgetting a card starts it over but keeps its ease, and counts the lapse', () => {
  const { c } = fresh();
  F.review(c, 'easy', TODAY); F.review(c, 'easy', '2026-10-08'); F.review(c, 'easy', '2026-10-14');
  const ease = c.ease;
  F.review(c, 'again', '2026-11-01');
  assert.strictEqual(c.reps, 0);
  assert.strictEqual(c.interval, 1);
  assert.strictEqual(c.ease, ease);
  assert.strictEqual(c.lapses, 1);
  F.review(c, 'good', '2026-11-02');
  assert.strictEqual(c.interval, 1, 'after a lapse the climb starts again');
});

test('previewing a grade changes nothing', () => {
  const { c } = fresh();
  const before = JSON.stringify(c);
  const r = F.schedule(c, 'good');
  assert.strictEqual(r.interval, 1);
  assert.strictEqual(JSON.stringify(c), before);
  assert.throws(() => F.schedule(c, 'meh'), /Unknown grade/);
});

test('intervals only ever grow while you keep getting it right', () => {
  const { c } = fresh();
  let last = 0, day = TODAY;
  for (let i = 0; i < 12; i++) { F.review(c, 'good', day); assert.ok(c.interval >= last); last = c.interval; day = c.due; }
  assert.ok(c.interval > 365, 'after twelve good answers it is months apart, not days');
});

test('the queue is the overdue cards first, then a limited number of new ones', () => {
  const s = F.create();
  const a = F.add(s, 'a', 'x', TODAY), b = F.add(s, 'b', 'x', TODAY), c = F.add(s, 'c', 'x', TODAY);
  for (let i = 0; i < 12; i++) F.add(s, 'n' + i, 'x', TODAY);
  F.review(a, 'good', '2026-10-01');          // due 2026-10-02: overdue
  F.review(b, 'good', '2026-10-05');          // due 2026-10-06: overdue, less so
  F.review(c, 'easy', TODAY);                 // due tomorrow: not yet
  const q = F.queue(s, TODAY, 10);
  assert.deepStrictEqual(q.slice(0, 2).map((x) => x.front), ['a', 'b']);
  assert.strictEqual(q.length, 2 + 10);
  assert.ok(!q.includes(c));
  assert.strictEqual(F.queue(s, TODAY, 0).length, 2);
});

test('stats say what is due, new and well learned', () => {
  const s = F.create();
  const a = F.add(s, 'a', 'x', TODAY); F.add(s, 'b', 'x', TODAY);
  a.seen = 1; a.interval = 30; a.due = '2026-10-01';
  assert.deepStrictEqual(F.stats(s, TODAY), { total: 2, due: 1, fresh: 1, learning: 0, mature: 1 });
});

test('cards come in from text, one "front :: back" per line, and go out the same way', () => {
  const s = F.create();
  const r = F.importText(s, 'capital of France :: Paris\n\nno separator here\n2 + 2 :: 4\n:: nothing in front');
  assert.deepStrictEqual(r, { added: 2, skipped: [3, 5] });
  assert.strictEqual(F.exportText(s), 'capital of France :: Paris\n2 + 2 :: 4\n');
  const again = F.create(); F.importText(again, F.exportText(s), TODAY);
  assert.deepStrictEqual(again.cards.map((c) => [c.front, c.back]), s.cards.map((c) => [c.front, c.back]));
});

test('the wording of a gap', () => {
  assert.deepStrictEqual([0, 1, 6, 15, 38, 100, 400, 800].map(F.describeInterval), ['today', '1 day', '6 days', '2 weeks', '5 weeks', '3 months', '1.1 years', '2.2 years']);
});

test('blank cards are refused, and deleting works', () => {
  const s = F.create();
  assert.strictEqual(F.add(s, '', 'x', TODAY), null);
  assert.strictEqual(F.add(s, 'x', '  ', TODAY), null);
  const c = F.add(s, 'x', 'y', TODAY);
  assert.strictEqual(F.remove(s, c.id), true);
  assert.strictEqual(F.remove(s, c.id), false);
});
done();
`;

const FLASH_UI = String.raw`(function () {
  'use strict';
  var F = window.Flashcards, kit = window.kit;
  var deck = kit.load('deck', null) || F.create();
  var tab = 'study', current = null, shown = false;
  function save() { kit.save('deck', deck); }

  function next() {
    var q = F.queue(deck, kit.today(), 10);
    current = q[0] || null; shown = false; study();
  }

  function study() {
    var host = kit.$('study'); host.textContent = '';
    var st = F.stats(deck, kit.today());
    kit.stats([['Due', st.due], ['New', st.fresh], ['Learning', st.learning], ['Mature', st.mature]]);
    if (!current) {
      host.appendChild(kit.el('h3', '', deck.cards.length ? 'All done for today' : 'No cards yet'));
      host.appendChild(kit.el('p', 'hint', deck.cards.length ? 'Come back tomorrow, or add more cards.' : 'Open the Cards tab and add some, or paste a list.'));
      return;
    }
    var card = kit.el('div', 'fcard card'); card.appendChild(kit.el('div', 'side', shown ? 'Answer' : 'Question'));
    card.appendChild(kit.el('div', 'ftext', current.front));
    if (shown) { card.appendChild(kit.el('hr')); card.appendChild(kit.el('div', 'ftext back', current.back)); }
    host.appendChild(card);
    var row = kit.el('div', 'row');
    if (!shown) {
      kit.buttons(row, [['Show answer (Space)', function () { shown = true; study(); }, 'primary']]);
    } else {
      [['again', 'Again', '1'], ['hard', 'Hard', '2'], ['good', 'Good', '3'], ['easy', 'Easy', '4']].forEach(function (g) {
        var r = F.schedule(current, g[0]);
        var b = kit.el('button', 'btn grade ' + g[0]); b.type = 'button';
        b.appendChild(kit.el('strong', '', g[1] + ' (' + g[2] + ')')); b.appendChild(kit.el('span', 'dim', F.describeInterval(r.interval)));
        b.addEventListener('click', function () { F.review(current, g[0], kit.today()); save(); next(); });
        row.appendChild(b);
      });
    }
    host.appendChild(row);
  }

  function cards() {
    var host = kit.$('cardlist'); host.textContent = '';
    deck.cards.slice().reverse().forEach(function (c) {
      var r = kit.el('div', 'crow2'); r.appendChild(kit.el('span', '', c.front)); r.appendChild(kit.el('span', 'dim', c.back));
      r.appendChild(kit.el('span', 'dim', c.seen ? 'next ' + c.due : 'new'));
      var del = kit.el('button', 'btn small danger', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Delete card');
      del.addEventListener('click', function () { F.remove(deck, c.id); save(); cards(); next(); });
      r.appendChild(del); host.appendChild(r);
    });
    if (!deck.cards.length) host.appendChild(kit.el('p', 'hint', 'Nothing here yet.'));
  }

  function show(t) {
    tab = t;
    ['study', 'cards'].forEach(function (x) { kit.$('page-' + x).hidden = x !== t; kit.$('tab-' + x).classList.toggle('on', x === t); });
    if (t === 'cards') cards(); else next();
  }

  kit.$('tab-study').addEventListener('click', function () { show('study'); });
  kit.$('tab-cards').addEventListener('click', function () { show('cards'); });
  kit.$('add').addEventListener('submit', function (e) {
    e.preventDefault();
    if (F.add(deck, kit.$('front').value, kit.$('back').value, kit.today())) { kit.$('front').value = ''; kit.$('back').value = ''; save(); cards(); kit.$('front').focus(); }
  });
  kit.$('bulk-add').addEventListener('click', function () {
    var r = F.importText(deck, kit.$('bulk').value, kit.today()); save(); cards();
    kit.toast('Added ' + r.added + ' card' + (r.added === 1 ? '' : 's') + (r.skipped.length ? '; skipped line' + (r.skipped.length === 1 ? ' ' : 's ') + r.skipped.join(', ') : '') + '.');
    if (r.added) kit.$('bulk').value = '';
  });
  kit.$('export').addEventListener('click', function () { kit.download('flashcards.txt', F.exportText(deck)); });
  document.addEventListener('keydown', function (e) {
    if (kit.typing(e) || tab !== 'study' || !current) return;
    if (e.key === ' ' && !shown) { e.preventDefault(); shown = true; study(); }
    else if (shown && '1234'.indexOf(e.key) >= 0 && e.key) { var g = ['again', 'hard', 'good', 'easy'][Number(e.key) - 1]; F.review(current, g, kit.today()); save(); next(); }
  });
  show('study');
})();
`;

export const flashcardsApp = webApp({
  id: 'flashcards',
  label: 'a flashcards app',
  summary: 'flashcards with spaced repetition (SM-2): cards come back when you are about to forget them',
  group: 'tool',
  words: ['flashcards', 'flash cards', 'flashcard', 'spaced repetition', 'anki', 'study cards', 'revision cards'],
  size: [860, 780],
  wide: true,
  body: `      <div class="fl">
        <div class="row"><button class="btn on" id="tab-study" type="button">Study</button><button class="btn" id="tab-cards" type="button">Cards</button></div>
        <section id="page-study"><div id="study" class="study"></div></section>
        <section id="page-cards" hidden>
          <form id="add" class="card row"><input id="front" placeholder="Front (question)" aria-label="Front"><input id="back" placeholder="Back (answer)" aria-label="Back"><button class="btn primary" type="submit">Add</button></form>
          <div class="card"><h2>Paste many at once</h2><textarea id="bulk" rows="4" placeholder="capital of France :: Paris&#10;2 + 2 :: 4" aria-label="Cards, one per line"></textarea><div class="row"><button class="btn small" id="bulk-add" type="button">Add them</button><button class="btn small" id="export" type="button">Export all</button></div></div>
          <div class="card"><div id="cardlist"></div></div>
        </section>
      </div>`,
  css: `
.fl { width: min(100%, 720px); margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.fl section { display: flex; flex-direction: column; gap: 12px; } .fl section[hidden] { display: none; }
.study { display: flex; flex-direction: column; gap: 16px; align-items: center; text-align: center; }
.fcard { width: 100%; min-height: 220px; display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 24px; } .side { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; }
.ftext { font-size: 26px; overflow-wrap: anywhere; } .ftext.back { color: var(--purple); } .fcard hr { width: 100%; border: 0; border-top: 1px solid var(--line); }
.grade { display: flex; flex-direction: column; min-width: 110px; padding: 10px 14px; } .grade.again { border-color: #7f1d1d; } .grade.good { border-color: var(--purple2); } .grade.easy { border-color: #14532d; }
.fl form input { flex: 1; min-width: 160px; } #bulk { width: 100%; resize: vertical; }
.crow2 { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); align-items: center; overflow-wrap: anywhere; }
`,
  logic: FLASH_LOGIC,
  ui: FLASH_UI,
  test: FLASH_TEST,
});
