/** A to-do list, a notes app and a Pomodoro timer. */

import { webApp } from './web-app';

// ------------------------------------------------------------------------------------ TO-DO

const TODO_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a to-do list. Pure logic. Dates are plain 'YYYY-MM-DD' strings and all
 * date arithmetic is done in UTC, so daylight-saving changes can never move a due date.
 *
 * Quick add understands a sentence: "call mom friday #family !high" becomes the task "call mom",
 * due on the next Friday, tagged family, high priority.
 */
(function (root) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function parseISO(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function toISO(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * 86400000); }
  function weekdayOf(iso) { return new Date(parseISO(iso)).getUTCDay(); }          // 0 = Sunday
  function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
  function validISO(iso) { return /^\d{4}-\d{2}-\d{2}$/.test(iso) && toISO(parseISO(iso)) === iso; }

  var DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  var SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  var PRIORITY = { high: 3, med: 2, medium: 2, low: 1 };

  // The next time that weekday comes round; today's own weekday means a week from now.
  function nextWeekday(today, target) {
    var delta = (target - weekdayOf(today) + 7) % 7;
    return addDays(today, delta === 0 ? 7 : delta);
  }

  // "buy milk tomorrow #home !high" -> { title, tags, due, priority }
  function parseQuick(text, today) {
    var title = ' ' + String(text || '') + ' ';
    var due = null, priority = 0, tags = [];

    title = title.replace(/\s#([A-Za-z][\w-]*)/g, function (m, t) { t = t.toLowerCase(); if (tags.indexOf(t) < 0) tags.push(t); return ' '; });
    title = title.replace(/\s!(high|medium|med|low)\b/i, function (m, p) { priority = PRIORITY[p.toLowerCase()]; return ' '; });

    // Dates are usually written at the end ("call mom friday"), so the LAST one that is a real date wins.
    function take(re, fn) {
      if (due) return;
      var g = new RegExp(re.source, 'gi'), m, last = null, found = null;
      while ((m = g.exec(title))) {
        var d = fn(m);
        if (d) { last = m; found = d; }
        if (m.index === g.lastIndex) g.lastIndex++;
      }
      if (last) { due = found; title = title.slice(0, last.index) + ' ' + title.slice(last.index + last[0].length); }
    }
    take(/\s(?:due\s+)?(\d{4}-\d{2}-\d{2})(?=\s)/i, function (m) { return validISO(m[1]) ? m[1] : null; });
    take(/\s(?:due\s+)?today(?=\s)/i, function () { return today; });
    take(/\s(?:due\s+)?tomorrow(?=\s)/i, function () { return addDays(today, 1); });
    take(/\s(?:due\s+)?next\s+week(?=\s)/i, function () { return addDays(today, 7); });
    take(/\sin\s+(\d{1,3})\s+days?(?=\s)/i, function (m) { return addDays(today, +m[1]); });
    take(/\s(?:due\s+|on\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?=\s)/i, function (m) { return nextWeekday(today, DAYS[m[1].toLowerCase()]); });
    take(/\s(?:due|on)\s+(mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)(?=\s)/i, function (m) { return nextWeekday(today, SHORT[m[1].toLowerCase()]); });

    var clean = title.replace(/\s+/g, ' ').trim();
    return { title: clean || String(text || '').trim(), tags: tags, due: due, priority: priority };
  }

  function create() { return { items: [], nextId: 1 }; }

  function add(s, text, today) {
    var p = parseQuick(text, today);
    if (!p.title) return null;
    var item = { id: s.nextId++, title: p.title, tags: p.tags, due: p.due, priority: p.priority, done: false, created: today, doneOn: null };
    s.items.push(item);
    return item;
  }

  function find(s, id) { for (var i = 0; i < s.items.length; i++) if (s.items[i].id === id) return s.items[i]; return null; }

  function toggle(s, id, today) {
    var it = find(s, id); if (!it) return null;
    it.done = !it.done; it.doneOn = it.done ? today : null;
    return it;
  }

  function edit(s, id, text, today) {
    var it = find(s, id); if (!it) return null;
    var p = parseQuick(text, today);
    if (!p.title) return null;
    it.title = p.title; it.tags = p.tags; it.due = p.due; it.priority = p.priority;
    return it;
  }

  // Removing hands the item back, so the page can offer "undo".
  function remove(s, id) {
    for (var i = 0; i < s.items.length; i++) if (s.items[i].id === id) return { item: s.items.splice(i, 1)[0], index: i };
    return null;
  }
  function restore(s, removed) { s.items.splice(Math.min(removed.index, s.items.length), 0, removed.item); }
  function clearDone(s) { var n = s.items.length; s.items = s.items.filter(function (i) { return !i.done; }); return n - s.items.length; }

  // 'done' | 'overdue' | 'today' | 'soon' (within 3 days) | 'later' | 'none'
  function status(item, today) {
    if (item.done) return 'done';
    if (!item.due) return 'none';
    var d = daysBetween(today, item.due);
    return d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 3 ? 'soon' : 'later';
  }

  function filter(items, f, today) {
    f = f || {};
    var q = (f.query || '').trim().toLowerCase();
    return items.filter(function (i) {
      if (f.status === 'active' && i.done) return false;
      if (f.status === 'done' && !i.done) return false;
      if (f.tag && i.tags.indexOf(f.tag) < 0) return false;
      if (q && i.title.toLowerCase().indexOf(q) < 0 && i.tags.join(' ').indexOf(q) < 0) return false;
      return true;
    });
  }

  // 'smart': open before done, overdue first, then by due date, then priority, then oldest.
  function sortItems(items, mode, today) {
    var rank = { overdue: 0, today: 1, soon: 2, later: 3, none: 4, done: 5 };
    var list = items.slice();
    list.sort(function (a, b) {
      if (mode === 'created') return a.id - b.id;
      if (mode === 'priority') return (b.priority - a.priority) || (a.id - b.id);
      var ra = rank[status(a, today)], rb = rank[status(b, today)];
      if (ra !== rb) return ra - rb;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      return (b.priority - a.priority) || (a.id - b.id);
    });
    return list;
  }

  function counts(s, today) {
    var c = { open: 0, done: 0, overdue: 0, today: 0 };
    s.items.forEach(function (i) {
      var st = status(i, today);
      if (i.done) c.done++; else c.open++;
      if (st === 'overdue') c.overdue++;
      if (st === 'today') c.today++;
    });
    return c;
  }

  function allTags(s) {
    var seen = {};
    s.items.forEach(function (i) { i.tags.forEach(function (t) { seen[t] = (seen[t] || 0) + 1; }); });
    return Object.keys(seen).sort();
  }

  // The words a due date is shown in: Today, Tomorrow, Mon 12 Oct, Overdue by 2 days.
  function describeDue(due, today) {
    if (!due) return '';
    var d = daysBetween(today, due);
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d === -1) return 'Overdue by 1 day';
    if (d < 0) return 'Overdue by ' + (-d) + ' days';
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var dt = new Date(parseISO(due));
    return names[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + months[dt.getUTCMonth()];
  }

  var api = { parseQuick: parseQuick, create: create, add: add, toggle: toggle, edit: edit, remove: remove, restore: restore, clearDone: clearDone,
    status: status, filter: filter, sortItems: sortItems, counts: counts, allTags: allTags, describeDue: describeDue,
    addDays: addDays, daysBetween: daysBetween, weekdayOf: weekdayOf, validISO: validISO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Todo = api;
})(typeof window !== 'undefined' ? window : this);
`;

const TODO_TEST = String.raw`
const T = require('./logic.js');
const TODAY = '2026-10-07';   // a Wednesday

test('dates are worked out in whole days, across months, years and leap days', () => {
  assert.strictEqual(T.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(T.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(T.addDays('2027-02-28', 1), '2027-03-01');
  assert.strictEqual(T.daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.strictEqual(T.weekdayOf(TODAY), 3);
  assert.strictEqual(T.validISO('2026-02-30'), false);
});

test('a sentence becomes a task, a due date, tags and a priority', () => {
  const p = T.parseQuick('call mom friday #family !high', TODAY);
  assert.deepStrictEqual(p, { title: 'call mom', tags: ['family'], due: '2026-10-09', priority: 3 });
});

test('the due words', () => {
  const due = (t) => T.parseQuick(t, TODAY).due;
  assert.strictEqual(due('pay rent today'), TODAY);
  assert.strictEqual(due('pay rent tomorrow'), '2026-10-08');
  assert.strictEqual(due('plan trip next week'), '2026-10-14');
  assert.strictEqual(due('dentist in 10 days'), '2026-10-17');
  assert.strictEqual(due('report due 2026-12-25'), '2026-12-25');
  assert.strictEqual(due('gym on mon'), '2026-10-12');
  assert.strictEqual(due('gym due fri'), '2026-10-09');
  assert.strictEqual(due('lunch next wednesday'), '2026-10-14', "today's own weekday means next week");
  assert.strictEqual(due('buy milk'), null);
  assert.strictEqual(due('read about saturn and the sun'), null, 'ordinary words are not days');
  assert.strictEqual(due('file by 2026-02-30'), null, 'an impossible date is not a date');
});

test('the words that carried the date leave the title', () => {
  assert.strictEqual(T.parseQuick('buy milk tomorrow', TODAY).title, 'buy milk');
  assert.strictEqual(T.parseQuick('due friday submit essay', TODAY).title, 'submit essay');
  assert.strictEqual(T.parseQuick('  lots   of   space ', TODAY).title, 'lots of space');
  assert.strictEqual(T.parseQuick('tomorrow', TODAY).title, 'tomorrow', 'a task that is only a date keeps its words');
});

test('tags are lower case and not repeated; # inside a word is left alone', () => {
  assert.deepStrictEqual(T.parseQuick('x #Home #home #work', TODAY).tags, ['home', 'work']);
  assert.strictEqual(T.parseQuick('issue#42 fix', TODAY).title, 'issue#42 fix');
});

test('adding, ticking, editing and removing', () => {
  const s = T.create();
  const a = T.add(s, 'one', TODAY), b = T.add(s, 'two #x', TODAY);
  assert.deepStrictEqual([a.id, b.id], [1, 2]);
  assert.strictEqual(T.add(s, '   ', TODAY), null);
  T.toggle(s, 1, TODAY);
  assert.strictEqual(s.items[0].done, true);
  assert.strictEqual(s.items[0].doneOn, TODAY);
  T.toggle(s, 1, TODAY);
  assert.strictEqual(s.items[0].doneOn, null);
  T.edit(s, 2, 'two b friday', TODAY);
  assert.strictEqual(s.items[1].due, '2026-10-09');
  const gone = T.remove(s, 1);
  assert.strictEqual(s.items.length, 1);
  T.restore(s, gone);
  assert.deepStrictEqual(s.items.map((i) => i.id), [1, 2]);
});

test('ids are never reused after a delete', () => {
  const s = T.create();
  T.add(s, 'a', TODAY); T.remove(s, 1);
  assert.strictEqual(T.add(s, 'b', TODAY).id, 2);
});

test('status says how urgent a task is', () => {
  const at = (due, done) => T.status({ due, done: !!done }, TODAY);
  assert.strictEqual(at('2026-10-06'), 'overdue');
  assert.strictEqual(at(TODAY), 'today');
  assert.strictEqual(at('2026-10-10'), 'soon');
  assert.strictEqual(at('2026-10-11'), 'later');
  assert.strictEqual(at(null), 'none');
  assert.strictEqual(at('2026-10-06', true), 'done');
});

test('smart order puts overdue first, then the soonest, and done tasks last', () => {
  const s = T.create();
  T.add(s, 'later', TODAY);
  T.add(s, 'send report friday', TODAY);
  T.add(s, 'late task 2026-10-01', TODAY);
  T.add(s, 'finished', TODAY); T.toggle(s, 4, TODAY);
  T.add(s, 'today thing today !high', TODAY);
  const order = T.sortItems(s.items, 'smart', TODAY).map((i) => i.title);
  assert.deepStrictEqual(order, ['late task', 'today thing', 'send report', 'later', 'finished']);
});

test('filters combine: status, tag and search', () => {
  const s = T.create();
  T.add(s, 'write report #work', TODAY); T.add(s, 'water plants #home', TODAY); T.add(s, 'report expenses #work', TODAY);
  T.toggle(s, 3, TODAY);
  assert.strictEqual(T.filter(s.items, { tag: 'work' }, TODAY).length, 2);
  assert.strictEqual(T.filter(s.items, { tag: 'work', status: 'active' }, TODAY).length, 1);
  assert.strictEqual(T.filter(s.items, { query: 'REPORT' }, TODAY).length, 2);
  assert.strictEqual(T.filter(s.items, { status: 'done' }, TODAY).length, 1);
  assert.deepStrictEqual(T.allTags(s), ['home', 'work']);
});

test('counts and the wording of a due date', () => {
  const s = T.create();
  T.add(s, 'a yesterday 2026-10-06', TODAY); T.add(s, 'b today', TODAY); T.add(s, 'c', TODAY); T.toggle(s, 3, TODAY);
  assert.deepStrictEqual(T.counts(s, TODAY), { open: 2, done: 1, overdue: 1, today: 1 });
  assert.strictEqual(T.describeDue('2026-10-06', TODAY), 'Overdue by 1 day');
  assert.strictEqual(T.describeDue('2026-10-02', TODAY), 'Overdue by 5 days');
  assert.strictEqual(T.describeDue('2026-10-08', TODAY), 'Tomorrow');
  assert.strictEqual(T.describeDue('2026-10-15', TODAY), 'Thu 15 Oct');
  assert.strictEqual(T.describeDue(null, TODAY), '');
});

test('clearing the done tasks reports how many went', () => {
  const s = T.create();
  T.add(s, 'a', TODAY); T.add(s, 'b', TODAY); T.toggle(s, 1, TODAY);
  assert.strictEqual(T.clearDone(s), 1);
  assert.strictEqual(s.items.length, 1);
});
done();
`;

const TODO_UI = String.raw`(function () {
  'use strict';
  var T = window.Todo, kit = window.kit;
  var state = kit.load('state', null) || T.create();
  var view = { status: 'all', tag: '', query: '' }, undo = null;
  var list = kit.$('list');

  function save() { kit.save('state', state); }

  function render() {
    var today = kit.today();
    var shown = T.sortItems(T.filter(state.items, view, today), 'smart', today);
    list.textContent = '';
    if (!shown.length) list.appendChild(kit.el('p', 'hint', state.items.length ? 'Nothing matches that.' : 'Nothing to do. Type a task above, like: call mom friday #family !high'));
    shown.forEach(function (it) {
      var row = kit.el('li', 'task ' + T.status(it, today));
      var box = kit.el('input'); box.type = 'checkbox'; box.checked = it.done; box.setAttribute('aria-label', 'Done: ' + it.title);
      box.addEventListener('change', function () { T.toggle(state, it.id, today); save(); render(); });
      var title = kit.el('span', 'ttitle', it.title);
      title.title = 'Double-click to edit';
      title.addEventListener('dblclick', function () { editInline(it, title, today); });
      row.appendChild(box); row.appendChild(title);
      if (it.priority) row.appendChild(kit.el('span', 'prio p' + it.priority, ['', 'low', 'med', 'high'][it.priority]));
      it.tags.forEach(function (t) { var c = kit.el('button', 'tag', '#' + t); c.type = 'button'; c.addEventListener('click', function () { view.tag = view.tag === t ? '' : t; render(); }); row.appendChild(c); });
      if (it.due) row.appendChild(kit.el('span', 'due', T.describeDue(it.due, today)));
      var del = kit.el('button', 'btn small danger', 'x'); del.type = 'button'; del.setAttribute('aria-label', 'Delete ' + it.title);
      del.addEventListener('click', function () { undo = T.remove(state, it.id); save(); render(); offerUndo(); });
      row.appendChild(del);
      list.appendChild(row);
    });
    var c = T.counts(state, today);
    kit.stats([['Open', c.open], ['Done', c.done], ['Overdue', c.overdue], ['Today', c.today]]);
    var tags = kit.$('tags'); tags.textContent = '';
    T.allTags(state).forEach(function (t) {
      var b = kit.el('button', 'btn small' + (view.tag === t ? ' on' : ''), '#' + t); b.type = 'button';
      b.addEventListener('click', function () { view.tag = view.tag === t ? '' : t; render(); });
      tags.appendChild(b);
    });
    ['all', 'active', 'done'].forEach(function (s) { kit.$('f-' + s).classList.toggle('on', view.status === s); });
  }

  function editInline(it, titleEl, today) {
    var input = kit.el('input'); input.value = it.title + (it.tags.length ? ' ' + it.tags.map(function (t) { return '#' + t; }).join(' ') : '') + (it.due ? ' ' + it.due : '');
    input.className = 'edit';
    titleEl.replaceWith(input); input.focus(); input.select();
    function done(ok) { if (ok) { T.edit(state, it.id, input.value, today); save(); } render(); }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', function () { done(true); });
  }

  function offerUndo() {
    var t = kit.$('toast'); if (!undo) return;
    kit.toast('Task deleted. Press Ctrl+Z to bring it back.');
  }
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undo && !kit.typing(e)) {
      e.preventDefault(); T.restore(state, undo); undo = null; save(); render(); kit.toast('Restored.');
    }
  });

  kit.$('add').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = kit.$('new');
    if (T.add(state, input.value, kit.today())) { input.value = ''; save(); render(); }
  });
  ['all', 'active', 'done'].forEach(function (s) { kit.$('f-' + s).addEventListener('click', function () { view.status = s; render(); }); });
  kit.$('search').addEventListener('input', function (e) { view.query = e.target.value; render(); });
  kit.$('clear').addEventListener('click', function () { var n = T.clearDone(state); save(); render(); kit.toast(n + ' done task' + (n === 1 ? '' : 's') + ' cleared.'); });
  render();
})();
`;

export const todoApp = webApp({
  id: 'todo',
  label: 'a to-do list',
  summary: 'a to-do list with quick add (dates, tags and priorities from a sentence), filters and undo',
  group: 'tool',
  words: ['to-do', 'todo', 'to do list', 'task list', 'task manager', 'checklist app', 'tasks app'],
  size: [760, 780],
  wide: true,
  body: `      <div class="todo">
        <form id="add" class="row"><input id="new" placeholder="Add a task:  call mom friday #family !high" autocomplete="off" aria-label="New task"><button class="btn primary" type="submit">Add</button></form>
        <div class="row"><button class="btn small on" id="f-all" type="button">All</button><button class="btn small" id="f-active" type="button">Open</button><button class="btn small" id="f-done" type="button">Done</button><input id="search" type="search" placeholder="Search" aria-label="Search"><button class="btn small" id="clear" type="button">Clear done</button></div>
        <div class="row" id="tags"></div>
        <ul id="list" class="tasks"></ul>
        <p class="hint">Dates: today, tomorrow, friday, next week, in 3 days, 2026-12-25. Priority: !high !med !low. Double-click a task to edit it.</p>
      </div>`,
  css: `
.todo { width: min(100%, 680px); margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.todo form input { flex: 1; min-width: 200px; }
.tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.task { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; flex-wrap: wrap; }
.task.done .ttitle { text-decoration: line-through; color: var(--dim); }
.task.overdue { border-color: #7f1d1d; } .task.today { border-color: var(--gold); }
.ttitle { flex: 1; min-width: 120px; cursor: text; }
.edit { flex: 1; }
.tag { background: none; border: 0; color: var(--purple); cursor: pointer; font: inherit; font-size: 13px; padding: 0 2px; }
.due { font-size: 12px; color: var(--dim); padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; }
.task.overdue .due { color: var(--bad); border-color: #7f1d1d; } .task.today .due { color: var(--gold); }
.prio { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 1px 6px; border-radius: 4px; }
.p3 { background: #7f1d1d; color: #fecaca; } .p2 { background: #78350f; color: #fde68a; } .p1 { background: #1e3a5f; color: #bfdbfe; }
`,
  logic: TODO_LOGIC,
  ui: TODO_UI,
  test: TODO_TEST,
});

// ------------------------------------------------------------------------------------ NOTES

const NOTES_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a notes app, and a small Markdown renderer that is safe by construction.
 *
 * The renderer ESCAPES everything first and only then adds its own tags, so a note can never
 * inject markup or script. Links are limited to http, https and mailto.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Inline formatting on text that is ALREADY escaped.
  function inline(text) {
    var codes = [];
    text = text.replace(/` + "`" + String.raw`([^` + "`" + String.raw`\n]+)` + "`" + String.raw`/g, function (m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    text = text.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    text = text.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, function (m, a, b) { return '<strong>' + (a || b) + '</strong>'; });
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)|(^|[^_\w])_([^_\n]+)_(?!\w)/g, function (m, p1, a, p2, b) { return (p1 || p2 || '') + '<em>' + (a || b) + '</em>'; });
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return text.replace(/\u0000(\d+)\u0000/g, function (m, i) { return '<code>' + codes[+i] + '</code>'; });
  }

  // Markdown -> HTML. Supports headings, paragraphs, bold/italic/strike/code, links, quotes,
  // bullet / numbered / task lists, fenced code blocks and rules.
  function render(md) {
    var lines = String(md).replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0, para = [];
    function flush() { if (para.length) { out.push('<p>' + inline(esc(para.join(' '))) + '</p>'); para = []; } }
    while (i < lines.length) {
      var line = lines[i], m;
      if ((m = /^` + "`" + String.raw`{3,}\s*([\w-]*)\s*$/.exec(line))) {
        flush();
        var code = []; i++;
        while (i < lines.length && !/^` + "`" + String.raw`{3,}\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        i++; continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flush(); out.push('<h' + m[1].length + '>' + inline(esc(m[2])) + '</h' + m[1].length + '>'); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^>\s?/.test(line)) {
        flush(); var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + inline(esc(quote.join(' '))) + '</blockquote>'); continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flush(); var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          var t = lines[i].replace(/^\s*[-*+]\s+/, ''), task = /^\[( |x|X)\]\s+(.*)$/.exec(t);
          items.push(task ? '<li class="task"><input type="checkbox" disabled' + (task[1] !== ' ' ? ' checked' : '') + '> ' + inline(esc(task[2])) + '</li>' : '<li>' + inline(esc(t)) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>'); continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flush(); var nums = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { nums.push('<li>' + inline(esc(lines[i].replace(/^\s*\d+[.)]\s+/, ''))) + '</li>'); i++; }
        out.push('<ol>' + nums.join('') + '</ol>'); continue;
      }
      para.push(line.trim()); i++;
    }
    flush();
    return out.join('\n');
  }

  // '#tag' words in a note (a heading's '# ' does not count, and neither does '#' inside a word).
  function tagsOf(body) {
    var tags = [], re = /(^|\s)#([A-Za-z][\w-]*)/g, m;
    while ((m = re.exec(body))) { var t = m[2].toLowerCase(); if (tags.indexOf(t) < 0) tags.push(t); }
    return tags;
  }

  function titleOf(body) {
    var lines = String(body).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s*#{1,6}\s*/, '').replace(/[*_` + "`" + String.raw`>]/g, '').trim();
      if (t) return t.length > 60 ? t.slice(0, 57) + '...' : t;
    }
    return 'Untitled';
  }

  function wordCount(body) { var m = String(body).match(/\S+/g); return m ? m.length : 0; }

  function create() { return { notes: [], nextId: 1 }; }

  function add(s, body, now) {
    var n = { id: s.nextId++, body: body || '', created: now, updated: now, pinned: false };
    s.notes.push(n); return n;
  }
  function get(s, id) { for (var i = 0; i < s.notes.length; i++) if (s.notes[i].id === id) return s.notes[i]; return null; }
  function update(s, id, body, now) { var n = get(s, id); if (!n) return null; if (n.body !== body) { n.body = body; n.updated = now; } return n; }
  function remove(s, id) { for (var i = 0; i < s.notes.length; i++) if (s.notes[i].id === id) return s.notes.splice(i, 1)[0]; return null; }
  function pin(s, id) { var n = get(s, id); if (n) n.pinned = !n.pinned; return n; }

  // Pinned notes first, then most recently changed. A query ranks title hits over tags over text.
  function search(notes, query) {
    var q = String(query || '').trim().toLowerCase();
    var scored = notes.map(function (n) {
      var score = 0;
      if (q) {
        score += titleOf(n.body).toLowerCase().indexOf(q) >= 0 ? 3 : 0;
        score += tagsOf(n.body).some(function (t) { return t.indexOf(q.replace(/^#/, '')) >= 0; }) ? 2 : 0;
        score += n.body.toLowerCase().indexOf(q) >= 0 ? 1 : 0;
        if (!score) return null;
      }
      return { n: n, score: score };
    }).filter(Boolean);
    scored.sort(function (a, b) {
      if (a.n.pinned !== b.n.pinned) return a.n.pinned ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return b.n.updated - a.n.updated;
    });
    return scored.map(function (x) { return x.n; });
  }

  var api = { render: render, esc: esc, tagsOf: tagsOf, titleOf: titleOf, wordCount: wordCount, create: create, add: add, get: get, update: update, remove: remove, pin: pin, search: search };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Notes = api;
})(typeof window !== 'undefined' ? window : this);
`;

const NOTES_TEST = String.raw`
const N = require('./logic.js');

test('markup in a note is shown as text, never run', () => {
  const html = N.render('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('only http, https and mailto links become links', () => {
  assert.ok(N.render('[ok](https://example.com/a?b=1&c=2)').includes('<a href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(N.render('[mail](mailto:me@example.com)').includes('mailto:me@example.com'));
  assert.ok(!N.render('[bad](javascript:alert(1))').includes('<a '));
  assert.ok(!N.render('[bad](data:text/html;base64,AAAA)').includes('<a '));
  assert.ok(!N.render('[bad](  javascript:alert(1))').includes('<a '));
});

test('a link cannot break out of its attribute', () => {
  const html = N.render('[x](https://a.com/"onmouseover="alert(1))');
  // The quotes in the address were escaped, so no real attribute can start after them.
  assert.ok(!/"\s*onmouseover=/.test(html), html);
  assert.ok(html.includes('&quot;onmouseover=&quot;'), html);
});

test('headings, emphasis, code and strike', () => {
  assert.strictEqual(N.render('# Title'), '<h1>Title</h1>');
  assert.strictEqual(N.render('###### small'), '<h6>small</h6>');
  assert.strictEqual(N.render('**bold** and *it* and ~~gone~~'), '<p><strong>bold</strong> and <em>it</em> and <del>gone</del></p>');
  assert.strictEqual(N.render('use ' + String.fromCharCode(96) + 'a < b' + String.fromCharCode(96) + ' here'), '<p>use <code>a &lt; b</code> here</p>');
});

test('formatting characters inside code are left alone', () => {
  const tick = String.fromCharCode(96);
  assert.strictEqual(N.render(tick + '**not bold**' + tick), '<p><code>**not bold**</code></p>');
});

test('lists, tasks, quotes, rules and code blocks', () => {
  assert.strictEqual(N.render('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(N.render('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.ok(N.render('- [x] done\n- [ ] todo').includes('<input type="checkbox" disabled checked>'));
  assert.strictEqual(N.render('> quoted'), '<blockquote>quoted</blockquote>');
  assert.strictEqual(N.render('---'), '<hr>');
  const fence = String.fromCharCode(96).repeat(3);
  assert.strictEqual(N.render(fence + 'js\nlet a = <b>1</b>;\n' + fence), '<pre><code>let a = &lt;b&gt;1&lt;/b&gt;;</code></pre>');
});

test('lines of one paragraph join, and a blank line starts the next', () => {
  assert.strictEqual(N.render('one\ntwo\n\nthree'), '<p>one two</p>\n<p>three</p>');
});

test('hostile input never throws', () => {
  const nasty = ['[', '](', '**', '____', '\u0000', String.fromCharCode(96), '# ', '> > >', '- [', '1.', '\n\n\n', 'a'.repeat(20000)];
  nasty.forEach((t) => { assert.strictEqual(typeof N.render(t), 'string'); });
});

test('tags come from #words only', () => {
  assert.deepStrictEqual(N.tagsOf('plan #Work and #home\n#work again'), ['work', 'home']);
  assert.deepStrictEqual(N.tagsOf('# Heading\nissue#42 and C#'), []);
});

test('a note is titled by its first line, without the markdown', () => {
  assert.strictEqual(N.titleOf('\n\n## Groceries *today*\nmilk'), 'Groceries today');
  assert.strictEqual(N.titleOf(''), 'Untitled');
  assert.strictEqual(N.titleOf('x'.repeat(100)).length, 60);
});

test('word count', () => {
  assert.strictEqual(N.wordCount('  one two\nthree  '), 3);
  assert.strictEqual(N.wordCount(''), 0);
});

test('notes are added, changed, pinned and removed', () => {
  const s = N.create();
  const a = N.add(s, '# One', 100), b = N.add(s, '# Two', 200);
  N.update(s, a.id, '# One edited', 300);
  assert.strictEqual(a.updated, 300);
  N.update(s, b.id, '# Two', 400);
  assert.strictEqual(b.updated, 200, 'saving the same text is not a change');
  N.pin(s, b.id);
  assert.deepStrictEqual(N.search(s.notes, '').map((n) => n.id), [2, 1], 'pinned first');
  assert.strictEqual(N.remove(s, 1).id, 1);
  assert.strictEqual(s.notes.length, 1);
});

test('search ranks title over tag over body, and ignores everything else', () => {
  const s = N.create();
  N.add(s, 'shopping list\nnothing special', 1);
  N.add(s, 'a note\nabout shopping in the text', 2);
  N.add(s, 'plans\n#shopping', 3);
  N.add(s, 'unrelated', 4);
  const ids = N.search(s.notes, 'shopping').map((n) => n.id);
  assert.deepStrictEqual(ids, [1, 3, 2]);
});
done();
`;

const NOTES_UI = String.raw`(function () {
  'use strict';
  var N = window.Notes, kit = window.kit;
  var state = kit.load('state', null) || N.create();
  var current = kit.load('current', null), query = '', timer = 0;
  var editor = kit.$('editor'), preview = kit.$('preview'), list = kit.$('notelist');

  function save() { kit.save('state', state); kit.save('current', current); }

  function renderList() {
    var notes = N.search(state.notes, query);
    list.textContent = '';
    notes.forEach(function (n) {
      var b = kit.el('button', 'nitem' + (n.id === current ? ' on' : '') + (n.pinned ? ' pinned' : ''));
      b.type = 'button';
      b.appendChild(kit.el('strong', '', (n.pinned ? '* ' : '') + N.titleOf(n.body)));
      b.appendChild(kit.el('span', 'dim', new Date(n.updated).toLocaleDateString() + ' - ' + N.wordCount(n.body) + ' words'));
      b.addEventListener('click', function () { open(n.id); });
      list.appendChild(b);
    });
    if (!notes.length) list.appendChild(kit.el('p', 'hint', state.notes.length ? 'No notes match.' : 'No notes yet. Press New.'));
    kit.stats([['Notes', state.notes.length], ['Words', state.notes.reduce(function (t, n) { return t + N.wordCount(n.body); }, 0)]]);
  }

  function open(id) {
    current = id;
    var n = N.get(state, id);
    editor.disabled = !n; editor.value = n ? n.body : '';
    preview.innerHTML = n ? N.render(n.body) : '';
    kit.$('pin').textContent = n && n.pinned ? 'Unpin' : 'Pin';
    save(); renderList();
  }

  function create() {
    var n = N.add(state, '', Date.now());
    open(n.id); editor.focus();
  }

  editor.addEventListener('input', function () {
    var n = N.get(state, current); if (!n) return;
    preview.innerHTML = N.render(editor.value);
    clearTimeout(timer);
    timer = setTimeout(function () { N.update(state, current, editor.value, Date.now()); save(); renderList(); }, 400);
  });
  kit.$('new').addEventListener('click', create);
  kit.$('pin').addEventListener('click', function () { N.pin(state, current); open(current); });
  kit.$('del').addEventListener('click', function () {
    var n = N.get(state, current); if (!n) return;
    if (n.body.trim() && !window.confirm('Delete this note?')) return;
    N.remove(state, current);
    var next = N.search(state.notes, '')[0];
    open(next ? next.id : null);
  });
  kit.$('export').addEventListener('click', function () {
    var n = N.get(state, current); if (!n) return;
    kit.download(N.titleOf(n.body).replace(/[^\w -]+/g, '').trim() + '.md', n.body, 'text/markdown');
  });
  kit.$('find').addEventListener('input', function (e) { query = e.target.value; renderList(); });

  if (!state.notes.length) { N.add(state, '# Welcome\n\nThis is your first note. Write in **Markdown** on the left; it appears on the right.\n\n- [x] Make a note\n- [ ] Add a #tag\n\n> Notes are saved on this computer as you type.', Date.now()); current = 1; }
  if (!N.get(state, current)) current = state.notes.length ? N.search(state.notes, '')[0].id : null;
  open(current);
})();
`;

export const notesApp = webApp({
  id: 'notes',
  label: 'a notes app',
  summary: 'a notes app: Markdown with a live preview, tags, search, pinning and export',
  group: 'tool',
  words: ['notes app', 'note taking', 'note-taking', 'notepad', 'notebook app', 'markdown editor', 'markdown notes'],
  size: [1060, 740],
  wide: true,
  body: `      <div class="notes">
        <aside class="side card"><div class="row"><button class="btn primary small" id="new" type="button">New</button><input id="find" type="search" placeholder="Search" aria-label="Search notes"></div><div id="notelist"></div></aside>
        <section class="edit card"><div class="row"><button class="btn small" id="pin" type="button">Pin</button><button class="btn small" id="export" type="button">Export .md</button><button class="btn small danger" id="del" type="button">Delete</button></div>
        <div class="panes"><textarea id="editor" spellcheck="true" aria-label="Note"></textarea><div id="preview" class="md"></div></div></section>
      </div>`,
  css: `
.notes { display: grid; grid-template-columns: 260px 1fr; gap: 14px; flex: 1; min-height: 0; }
.side { display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
.side input { flex: 1; min-width: 0; }
#notelist { overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.nitem { text-align: left; background: none; border: 1px solid transparent; border-radius: 8px; padding: 8px 10px; color: var(--text); font: inherit; cursor: pointer; display: flex; flex-direction: column; }
.nitem:hover { background: #1a1030; } .nitem.on { border-color: var(--purple2); background: #1a1030; }
.nitem span { font-size: 12px; }
.edit { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.panes { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
#editor { resize: none; font: 14px/1.6 Consolas, "Cascadia Mono", monospace; min-height: 420px; }
.md { overflow-y: auto; padding: 4px 10px; border-left: 1px solid var(--line); }
.md h1, .md h2, .md h3 { color: var(--purple); margin: 0.6em 0 0.3em; }
.md code { background: #1a1030; padding: 1px 5px; border-radius: 4px; font-family: Consolas, monospace; }
.md pre { background: #0a0613; padding: 10px; border-radius: 8px; overflow-x: auto; }
.md blockquote { margin: 0.6em 0; padding-left: 12px; border-left: 3px solid var(--purple2); color: var(--dim); }
.md a { color: #c4b5fd; } .md ul { padding-left: 20px; } .md li.task { list-style: none; margin-left: -18px; }
@media (max-width: 760px) { .notes { grid-template-columns: 1fr; } .panes { grid-template-columns: 1fr; } }
`,
  logic: NOTES_LOGIC,
  ui: NOTES_UI,
  test: NOTES_TEST,
});

// ------------------------------------------------------------------------------------ POMODORO

const POMO_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a Pomodoro timer. Pure logic: nothing here reads a clock, the page passes
 * the time in. A running timer stores the moment it ENDS (not a count of ticks), so a sleeping
 * laptop, a throttled background tab or a slow frame can never make it drift.
 */
(function (root) {
  'use strict';

  var DEFAULTS = { work: 25, short: 5, long: 15, every: 4, autoNext: false };

  function minutes(cfg, phase) { return cfg[phase] * 60000; }

  function create(cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    return { cfg: cfg, phase: 'work', running: false, endsAt: 0, remaining: minutes(cfg, 'work'), completed: 0, focusMs: 0 };
  }

  function remaining(s, now) { return s.running ? Math.max(0, s.endsAt - now) : s.remaining; }

  function start(s, now) { if (s.running) return s; s.running = true; s.endsAt = now + s.remaining; return s; }
  function pause(s, now) { if (!s.running) return s; s.remaining = Math.max(0, s.endsAt - now); s.running = false; return s; }

  function enter(s, phase) { s.phase = phase; s.running = false; s.remaining = minutes(s.cfg, phase); s.endsAt = 0; }

  // After work comes a short break, except every Nth work session, which earns a long one.
  function nextPhase(s) {
    if (s.phase !== 'work') return 'work';
    return s.completed > 0 && s.completed % s.cfg.every === 0 ? 'long' : 'short';
  }

  // Call this often. Returns { finished } when a phase ran out, otherwise null.
  function tick(s, now) {
    if (!s.running || now < s.endsAt) return null;
    var finished = s.phase;
    if (finished === 'work') { s.completed += 1; s.focusMs += minutes(s.cfg, 'work'); }
    enter(s, nextPhase(s));
    if (s.cfg.autoNext) { s.running = true; s.endsAt = now + s.remaining; }
    return { finished: finished, next: s.phase };
  }

  // Skip to the next phase. A skipped work session does not count as focus time.
  function skip(s) { enter(s, s.phase === 'work' ? 'short' : 'work'); return s; }

  function reset(s) { enter(s, s.phase); return s; }

  function configure(s, cfg) {
    s.cfg = Object.assign({}, s.cfg, cfg);
    if (!s.running) s.remaining = minutes(s.cfg, s.phase);
    return s;
  }

  function format(ms) {
    var total = Math.ceil(ms / 1000), m = Math.floor(total / 60), sec = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function progress(s, now) { var full = minutes(s.cfg, s.phase); return full ? 1 - remaining(s, now) / full : 0; }

  var api = { DEFAULTS: DEFAULTS, create: create, start: start, pause: pause, tick: tick, skip: skip, reset: reset, configure: configure, remaining: remaining, format: format, progress: progress, nextPhase: nextPhase };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Pomodoro = api;
})(typeof window !== 'undefined' ? window : this);
`;

const POMO_TEST = String.raw`
const P = require('./logic.js');
const MIN = 60000;

test('a new timer is ready to focus for 25 minutes', () => {
  const s = P.create();
  assert.strictEqual(s.phase, 'work');
  assert.strictEqual(s.running, false);
  assert.strictEqual(P.format(P.remaining(s, 0)), '25:00');
});

test('it counts down from the moment it starts', () => {
  const s = P.create();
  P.start(s, 1000);
  assert.strictEqual(P.remaining(s, 1000 + 10 * MIN), 15 * MIN);
  assert.strictEqual(P.format(P.remaining(s, 1000 + 10 * MIN)), '15:00');
});

test('pausing keeps the time left, and resuming carries on from it', () => {
  const s = P.create();
  P.start(s, 0); P.pause(s, 5 * MIN);
  assert.strictEqual(s.remaining, 20 * MIN);
  assert.strictEqual(P.remaining(s, 99 * MIN), 20 * MIN, 'a paused timer does not run');
  P.start(s, 50 * MIN);
  assert.strictEqual(P.remaining(s, 60 * MIN), 10 * MIN);
});

test('starting twice or pausing twice changes nothing', () => {
  const s = P.create();
  P.start(s, 0); P.start(s, 10 * MIN);
  assert.strictEqual(s.endsAt, 25 * MIN);
  P.pause(s, 1 * MIN); P.pause(s, 9 * MIN);
  assert.strictEqual(s.remaining, 24 * MIN);
});

test('time up moves on to a break and counts the focus', () => {
  const s = P.create();
  P.start(s, 0);
  assert.strictEqual(P.tick(s, 24 * MIN), null);
  const e = P.tick(s, 25 * MIN);
  assert.deepStrictEqual(e, { finished: 'work', next: 'short' });
  assert.strictEqual(s.phase, 'short');
  assert.strictEqual(s.running, false, 'it waits to be started again');
  assert.strictEqual(s.completed, 1);
  assert.strictEqual(s.focusMs, 25 * MIN);
});

test('every fourth work session earns the long break', () => {
  const s = P.create();
  const seen = [];
  let now = 0;
  for (let i = 0; i < 8; i++) {
    P.start(s, now); now += s.remaining; const e = P.tick(s, now); seen.push(e.next);
    P.start(s, now); now += s.remaining; P.tick(s, now);     // the break, then back to work
  }
  assert.deepStrictEqual(seen, ['short', 'short', 'short', 'long', 'short', 'short', 'short', 'long']);
  assert.strictEqual(s.completed, 8);
  assert.strictEqual(s.focusMs, 8 * 25 * MIN);
});

test('a laptop that slept through the end only finishes one phase', () => {
  const s = P.create();
  P.start(s, 0);
  const e = P.tick(s, 10 * 60 * MIN);
  assert.strictEqual(e.finished, 'work');
  assert.strictEqual(s.phase, 'short');
  assert.strictEqual(P.tick(s, 10 * 60 * MIN), null);
});

test('skipping a work session does not count it as focus', () => {
  const s = P.create();
  P.start(s, 0); P.skip(s);
  assert.strictEqual(s.phase, 'short');
  assert.strictEqual(s.completed, 0);
  assert.strictEqual(s.focusMs, 0);
  P.skip(s);
  assert.strictEqual(s.phase, 'work');
});

test('reset puts the current phase back to its full length', () => {
  const s = P.create();
  P.start(s, 0); P.pause(s, 7 * MIN); P.reset(s);
  assert.strictEqual(s.remaining, 25 * MIN);
  assert.strictEqual(s.running, false);
});

test('auto-next starts the following phase by itself', () => {
  const s = P.create({ autoNext: true });
  P.start(s, 0); P.tick(s, 25 * MIN);
  assert.strictEqual(s.running, true);
  assert.strictEqual(P.remaining(s, 25 * MIN), 5 * MIN);
});

test('changing the lengths takes effect now, unless the timer is running', () => {
  const s = P.create();
  P.configure(s, { work: 50 });
  assert.strictEqual(s.remaining, 50 * MIN);
  P.start(s, 0); P.configure(s, { work: 10 });
  assert.strictEqual(P.remaining(s, 0), 50 * MIN, 'a running timer is left alone');
});

test('the clock shows whole seconds, rounding up so it never reads 00:00 early', () => {
  assert.strictEqual(P.format(0), '00:00');
  assert.strictEqual(P.format(1), '00:01');
  assert.strictEqual(P.format(59 * 1000 + 1), '01:00');
  assert.strictEqual(P.format(90 * MIN), '90:00');
});

test('progress runs from 0 to 1', () => {
  const s = P.create();
  P.start(s, 0);
  assert.strictEqual(P.progress(s, 0), 0);
  assert.ok(Math.abs(P.progress(s, 12.5 * MIN) - 0.5) < 1e-9);
  assert.strictEqual(P.progress(s, 25 * MIN), 1);
});
done();
`;

const POMO_UI = String.raw`(function () {
  'use strict';
  var P = window.Pomodoro, kit = window.kit;
  var state = P.create(kit.load('cfg', null) || {});
  var LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };
  var days = kit.load('days', {});
  var ring = kit.$('ring'), CIRC = 2 * Math.PI * 90;
  ring.setAttribute('stroke-dasharray', CIRC.toFixed(1));

  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), t = ctx.currentTime;
      [660, 880, 660].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t + i * 0.25); g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.25 + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.25 + 0.22);
        o.start(t + i * 0.25); o.stop(t + i * 0.25 + 0.25);
      });
    } catch (e) { /* no audio is fine */ }
  }

  function render() {
    var now = Date.now(), left = P.remaining(state, now);
    kit.$('time').textContent = P.format(left);
    kit.$('phase').textContent = LABEL[state.phase];
    ring.setAttribute('stroke-dashoffset', (CIRC * (1 - P.progress(state, now))).toFixed(1));
    ring.setAttribute('class', 'ring ' + state.phase);
    kit.$('toggle').textContent = state.running ? 'Pause' : 'Start';
    document.title = P.format(left) + ' ' + LABEL[state.phase];
    var inSet = state.completed % state.cfg.every;
    var dots = kit.$('dots'); dots.textContent = '';
    for (var i = 0; i < state.cfg.every; i++) dots.appendChild(kit.el('span', 'dot' + (i < inSet || (state.phase !== 'work' && state.completed > 0 && inSet === 0) ? ' on' : '')));
    var today = days[kit.today()] || { sessions: 0, minutes: 0 };
    kit.stats([['Today', today.sessions + ' sessions'], ['Focused', today.minutes + ' min'], ['Total', state.completed]]);
  }

  function tick() {
    var e = P.tick(state, Date.now());
    if (e) {
      if (e.finished === 'work') {
        var key = kit.today(); days[key] = days[key] || { sessions: 0, minutes: 0 };
        days[key].sessions++; days[key].minutes += state.cfg.work; kit.save('days', days);
      }
      beep(); kit.toast(e.finished === 'work' ? 'Focus session done. Time for a ' + LABEL[e.next].toLowerCase() + '.' : 'Break over. Ready to focus?');
    }
    render();
  }

  kit.$('toggle').addEventListener('click', function () { if (state.running) P.pause(state, Date.now()); else P.start(state, Date.now()); render(); });
  kit.$('skip').addEventListener('click', function () { P.skip(state); render(); });
  kit.$('reset').addEventListener('click', function () { P.reset(state); render(); });
  ['work', 'short', 'long', 'every'].forEach(function (k) {
    var input = kit.$('cfg-' + k); input.value = state.cfg[k];
    input.addEventListener('change', function () {
      var v = Math.max(1, Math.min(180, Math.round(Number(input.value) || state.cfg[k])));
      input.value = v;
      var patch = {}; patch[k] = v; P.configure(state, patch); kit.save('cfg', state.cfg); render();
    });
  });
  document.addEventListener('keydown', function (e) { if (e.key === ' ' && !kit.typing(e)) { e.preventDefault(); kit.$('toggle').click(); } });
  setInterval(tick, 250);
  render();
})();
`;

export const pomodoroApp = webApp({
  id: 'pomodoro',
  label: 'a pomodoro timer',
  summary: 'a Pomodoro focus timer with short and long breaks, a progress ring, sound and daily totals',
  group: 'tool',
  words: ['pomodoro', 'focus timer', 'study timer', 'work timer', 'productivity timer'],
  size: [520, 760],
  body: `      <div class="pomo">
        <svg viewBox="0 0 200 200" width="280" height="280" aria-hidden="true"><circle cx="100" cy="100" r="90" class="track"/><circle id="ring" cx="100" cy="100" r="90" class="ring work" transform="rotate(-90 100 100)" stroke-dashoffset="0"/></svg>
        <div class="clock"><div id="time" class="time">25:00</div><div id="phase" class="dim">Focus</div></div>
      </div>
      <div class="row" id="dots"></div>
      <div class="row"><button class="btn primary" id="toggle" type="button">Start</button><button class="btn" id="skip" type="button">Skip</button><button class="btn" id="reset" type="button">Reset</button></div>
      <div class="row cfg"><label>Focus <input id="cfg-work" type="number" min="1" max="180"></label><label>Short <input id="cfg-short" type="number" min="1" max="180"></label><label>Long <input id="cfg-long" type="number" min="1" max="180"></label><label>Long break every <input id="cfg-every" type="number" min="2" max="12"></label></div>
      <p class="hint">Space starts and pauses. The time is kept by the clock, so it stays right even when the window is in the background.</p>`,
  css: `
.pomo { position: relative; width: 280px; height: 280px; }
.pomo svg { display: block; }
.track { fill: none; stroke: var(--line); stroke-width: 8; }
.ring { fill: none; stroke: var(--purple); stroke-width: 8; stroke-linecap: round; transition: stroke-dashoffset 0.3s linear; filter: drop-shadow(0 0 6px var(--glow)); }
.ring.short { stroke: var(--good); } .ring.long { stroke: var(--gold); }
.clock { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.time { font-size: 56px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--purple2); }
.dot.on { background: var(--purple); box-shadow: 0 0 8px var(--glow); }
.cfg label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.cfg input { width: 64px; padding: 4px 6px; }
`,
  logic: POMO_LOGIC,
  ui: POMO_UI,
  test: POMO_TEST,
});
