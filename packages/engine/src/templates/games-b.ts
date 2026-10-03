/** Memory Match, Tic-Tac-Toe (with an AI that cannot be beaten) and Breakout. */

import { webApp } from './web-app';

// ------------------------------------------------------------------------------------ MEMORY

const MEMORY_LOGIC = String.raw`/*
 * {{NAME}} - the rules of a memory-match game. Pure logic; shuffling uses the generator you pass in.
 */
(function (root) {
  'use strict';

  var SYMBOLS = ['🐙', '🦊', '🐢', '🦉', '🐝', '🦋', '🐳', '🦄',
    '🍄', '🌵', '🍉', '🍕', '🎲', '🎸', '🚀', '⚡', '🔮', '🌙'];

  // Fisher-Yates: every ordering is equally likely.
  function shuffle(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function create(pairs, rng) {
    pairs = Math.max(2, Math.min(pairs, SYMBOLS.length));
    var picked = shuffle(SYMBOLS, rng).slice(0, pairs);
    var deck = shuffle(picked.concat(picked), rng).map(function (sym, i) { return { id: i, sym: sym, open: false, matched: false }; });
    return { cards: deck, first: -1, pending: null, moves: 0, matches: 0, pairs: pairs };
  }

  // Turn a card over. Returns what happened:
  //   'first' (first of a pair), 'match', 'mismatch' (call resolve() to turn them back),
  //   'won', 'ignored' (already showing / matched), 'locked' (a mismatch is still showing).
  function flip(s, i) {
    if (s.pending) return 'locked';
    var c = s.cards[i];
    if (!c || c.open || c.matched) return 'ignored';
    c.open = true;
    if (s.first < 0) { s.first = i; return 'first'; }
    s.moves += 1;
    var a = s.cards[s.first];
    if (a.sym === c.sym) {
      a.matched = true; c.matched = true; s.matches += 1; s.first = -1;
      return s.matches === s.pairs ? 'won' : 'match';
    }
    s.pending = [s.first, i]; s.first = -1;
    return 'mismatch';
  }

  function resolve(s) {
    if (!s.pending) return false;
    s.pending.forEach(function (i) { s.cards[i].open = false; });
    s.pending = null;
    return true;
  }

  var api = { create: create, flip: flip, resolve: resolve, shuffle: shuffle, SYMBOLS: SYMBOLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Memory = api;
})(typeof window !== 'undefined' ? window : this);
`;

const MEMORY_TEST = String.raw`
const M = require('./logic.js');

test('shuffling keeps every card and is repeatable for a seed', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const a = M.shuffle(list, seeded(4)), b = M.shuffle(list, seeded(4)), c = M.shuffle(list, seeded(5));
  assert.deepStrictEqual(a.slice().sort((x, y) => x - y), list);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, c);
});

test('shuffling is fair: each card lands in each place about equally often', () => {
  const rng = seeded(99), counts = [0, 0, 0, 0];
  for (let i = 0; i < 8000; i++) counts[M.shuffle([0, 1, 2, 3], rng).indexOf(0)]++;
  counts.forEach((n) => assert.ok(n > 1800 && n < 2200, 'position counts ' + counts));
});

test('every symbol appears exactly twice', () => {
  const s = M.create(8, seeded(1));
  assert.strictEqual(s.cards.length, 16);
  const seen = {};
  s.cards.forEach((c) => { seen[c.sym] = (seen[c.sym] || 0) + 1; });
  assert.strictEqual(Object.keys(seen).length, 8);
  Object.values(seen).forEach((n) => assert.strictEqual(n, 2));
});

test('asking for too many pairs is trimmed to the symbols there are', () => {
  assert.strictEqual(M.create(99, seeded(1)).pairs, M.SYMBOLS.length);
  assert.strictEqual(M.create(0, seeded(1)).pairs, 2);
});

function find(s, wantMatch) {
  for (let i = 0; i < s.cards.length; i++) for (let j = i + 1; j < s.cards.length; j++) {
    if ((s.cards[i].sym === s.cards[j].sym) === wantMatch) return [i, j];
  }
}

test('a matching pair stays turned over and counts one move', () => {
  const s = M.create(6, seeded(2));
  const [i, j] = find(s, true);
  assert.strictEqual(M.flip(s, i), 'first');
  assert.strictEqual(M.flip(s, j), 'match');
  assert.strictEqual(s.moves, 1);
  assert.ok(s.cards[i].matched && s.cards[j].matched);
});

test('a mismatch locks the board until it is resolved, then turns both back', () => {
  const s = M.create(6, seeded(2));
  const [i, j] = find(s, false);
  M.flip(s, i);
  assert.strictEqual(M.flip(s, j), 'mismatch');
  const other = s.cards.findIndex((c, k) => k !== i && k !== j);
  assert.strictEqual(M.flip(s, other), 'locked');
  assert.strictEqual(s.cards[other].open, false);
  assert.strictEqual(M.resolve(s), true);
  assert.ok(!s.cards[i].open && !s.cards[j].open);
  assert.strictEqual(M.resolve(s), false);
});

test('clicking a card that is already showing does nothing', () => {
  const s = M.create(6, seeded(2));
  M.flip(s, 0);
  assert.strictEqual(M.flip(s, 0), 'ignored');
  assert.strictEqual(s.moves, 0);
});

test('a perfect player clears the board in exactly one move per pair', () => {
  const s = M.create(8, seeded(3));
  const bySym = {};
  s.cards.forEach((c, i) => { (bySym[c.sym] = bySym[c.sym] || []).push(i); });
  let last;
  Object.values(bySym).forEach(([i, j]) => { M.flip(s, i); last = M.flip(s, j); });
  assert.strictEqual(last, 'won');
  assert.strictEqual(s.moves, 8);
});
done();
`;

const MEMORY_UI = String.raw`(function () {
  'use strict';
  var M = window.Memory, kit = window.kit;
  var SIZES = { small: [8, '4 x 4'], medium: [10, '4 x 5'], large: [18, '6 x 6'] };
  var size = kit.load('size', 'small'), state, seconds = 0, timer = 0, busy = false;
  var board = kit.$('board');

  function build() {
    clearInterval(timer); timer = 0; seconds = 0; busy = false;
    state = M.create(SIZES[size][0], Math.random);
    board.textContent = '';
    var cols = size === 'large' ? 6 : (size === 'medium' ? 5 : 4);
    board.style.gridTemplateColumns = 'repeat(' + cols + ', var(--card))';
    board.className = 'memory ' + size;
    state.cards.forEach(function (c, i) {
      var b = kit.el('button', 'mcard');
      b.type = 'button'; b.dataset.i = i; b.setAttribute('aria-label', 'Card ' + (i + 1));
      var inner = kit.el('span', 'inner');
      inner.appendChild(kit.el('span', 'face front', '?'));
      inner.appendChild(kit.el('span', 'face back', c.sym));
      b.appendChild(inner); board.appendChild(b);
    });
    stats(); kit.$('msg').textContent = 'Find the pairs.';
  }

  function stats() {
    kit.stats([['Moves', state.moves], ['Pairs', state.matches + '/' + state.pairs], ['Time', seconds + 's'], ['Best', kit.load('best-' + size, '-')]]);
  }

  function paint() {
    state.cards.forEach(function (c, i) {
      var b = board.children[i];
      b.className = 'mcard' + (c.open || c.matched ? ' flipped' : '') + (c.matched ? ' done' : '');
    });
    stats();
  }

  board.addEventListener('click', function (e) {
    var b = e.target.closest('.mcard'); if (!b || busy) return;
    if (!timer) timer = setInterval(function () { seconds++; stats(); }, 1000);
    var r = M.flip(state, Number(b.dataset.i));
    paint();
    if (r === 'mismatch') {
      busy = true; kit.$('msg').textContent = 'Not a pair.';
      setTimeout(function () { M.resolve(state); busy = false; paint(); }, 750);
    } else if (r === 'match') kit.$('msg').textContent = 'A pair!';
    else if (r === 'won') {
      clearInterval(timer); timer = 0;
      var best = kit.load('best-' + size, 0);
      if (!best || state.moves < best) { kit.save('best-' + size, state.moves); kit.$('msg').textContent = 'Cleared in ' + state.moves + ' moves. A new best!'; }
      else kit.$('msg').textContent = 'Cleared in ' + state.moves + ' moves (best ' + best + ').';
      stats();
    }
  });

  var sel = kit.$('size');
  Object.keys(SIZES).forEach(function (k) { var o = kit.el('option', '', k + ' (' + SIZES[k][1] + ')'); o.value = k; sel.appendChild(o); });
  sel.value = size;
  sel.addEventListener('change', function () { size = sel.value; kit.save('size', size); build(); });
  kit.$('again').addEventListener('click', build);
  build();
})();
`;

export const memoryGame = webApp({
  id: 'memory',
  label: 'a memory match game',
  summary: 'a memory-match card game with three board sizes and best scores',
  group: 'game',
  words: ['memory game', 'memory match', 'matching game', 'concentration game', 'card matching', 'pairs game', 'memory card'],
  size: [760, 800],
  body: `      <div class="row"><select id="size" aria-label="Board size"></select><button class="btn primary" id="again" type="button">New game</button></div>
      <p class="hint" id="msg" aria-live="polite"></p>
      <div id="board" class="memory"></div>`,
  css: `
.memory { --card: 88px; display: grid; gap: 10px; }
.memory.large { --card: 70px; }
.mcard { width: var(--card); height: var(--card); padding: 0; border: 0; background: none; perspective: 600px; cursor: pointer; }
.mcard .inner { position: relative; display: block; width: 100%; height: 100%; transition: transform 0.35s; transform-style: preserve-3d; }
.mcard.flipped .inner { transform: rotateY(180deg); }
.face { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 12px; backface-visibility: hidden; font-size: calc(var(--card) * 0.5); }
.face.front { background: linear-gradient(135deg, #2d1b4e, #1a1030); border: 1px solid var(--line); color: var(--purple); font-weight: 700; }
.face.back { background: #170d2c; border: 1px solid var(--purple2); transform: rotateY(180deg); }
.mcard:hover:not(.flipped) .front { border-color: var(--purple2); }
.mcard.done .back { border-color: var(--good); box-shadow: 0 0 14px rgba(52, 211, 153, 0.35); }
`,
  logic: MEMORY_LOGIC,
  ui: MEMORY_UI,
  test: MEMORY_TEST,
});

// ------------------------------------------------------------------------------------ TIC-TAC-TOE

const TTT_LOGIC = String.raw`/*
 * {{NAME}} - the rules of tic-tac-toe, and an opponent that plays it perfectly.
 *
 * A board is 9 cells, each '' / 'X' / 'O'. The hard computer player searches EVERY continuation
 * (minimax with alpha-beta pruning) and prefers the quickest win and the slowest loss, so it never
 * loses; the test.js file proves that by playing it against every possible human game.
 */
(function (root) {
  'use strict';

  var LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

  function other(p) { return p === 'X' ? 'O' : 'X'; }

  // { who: 'X'|'O', line: [a,b,c] } for a win, 'draw' for a full board, or null while play goes on.
  function result(b) {
    for (var i = 0; i < LINES.length; i++) {
      var l = LINES[i];
      if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return { who: b[l[0]], line: l };
    }
    return b.every(function (c) { return c; }) ? 'draw' : null;
  }

  function moves(b) { var m = []; for (var i = 0; i < 9; i++) if (!b[i]) m.push(i); return m; }

  // Value of the position for 'me' with 'turn' to move: +10-depth for a win, depth-10 for a loss.
  function search(b, turn, me, depth, alpha, beta) {
    var r = result(b);
    if (r === 'draw') return 0;
    if (r) return r.who === me ? 10 - depth : depth - 10;
    var best = turn === me ? -100 : 100;
    var list = moves(b);
    for (var k = 0; k < list.length; k++) {
      b[list[k]] = turn;
      var v = search(b, other(turn), me, depth + 1, alpha, beta);
      b[list[k]] = '';
      if (turn === me) { if (v > best) best = v; if (best > alpha) alpha = best; }
      else { if (v < best) best = v; if (best < beta) beta = best; }
      if (beta <= alpha) break;
    }
    return best;
  }

  // Natural-looking order among equal moves: centre, corners, then edges.
  var PREFERENCE = [4, 0, 2, 6, 8, 1, 3, 5, 7];

  // All the best moves for 'player', in preference order.
  function bestMoves(b, player) {
    var list = moves(b).slice().sort(function (x, y) { return PREFERENCE.indexOf(x) - PREFERENCE.indexOf(y); });
    var scored = list.map(function (m) {
      b[m] = player;
      var v = search(b, other(player), player, 1, -100, 100);
      b[m] = '';
      return { move: m, value: v };
    });
    var top = Math.max.apply(null, scored.map(function (s) { return s.value; }));
    return scored.filter(function (s) { return s.value === top; }).map(function (s) { return s.move; });
  }

  // level: 'hard' always plays the best move, 'medium' errs half the time, 'easy' plays at random.
  function aiMove(b, player, level, rng) {
    var list = moves(b);
    if (!list.length) return -1;
    var chance = level === 'easy' ? 1 : (level === 'medium' ? 0.5 : 0);
    if (rng() < chance) return list[Math.floor(rng() * list.length) % list.length];
    return bestMoves(b, player)[0];
  }

  function empty() { return ['', '', '', '', '', '', '', '', '']; }

  var api = { LINES: LINES, result: result, moves: moves, bestMoves: bestMoves, aiMove: aiMove, empty: empty, other: other };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TicTacToe = api;
})(typeof window !== 'undefined' ? window : this);
`;

const TTT_TEST = String.raw`
const T = require('./logic.js');

test('every one of the eight lines wins, and a full board without one is a draw', () => {
  T.LINES.forEach((l) => {
    const b = T.empty(); l.forEach((i) => { b[i] = 'X'; });
    assert.strictEqual(T.result(b).who, 'X');
    assert.deepStrictEqual(T.result(b).line, l);
  });
  assert.strictEqual(T.result(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']), 'draw');
  assert.strictEqual(T.result(T.empty()), null);
});

// Count every possible game: the well-known totals are 255,168 games in all.
function enumerate(b, turn, tally) {
  const r = T.result(b);
  if (r) { tally.games++; if (r === 'draw') tally.draws++; else tally[r.who]++; return; }
  T.moves(b).forEach((m) => { b[m] = turn; enumerate(b, T.other(turn), tally); b[m] = ''; });
}

test('the rules produce exactly the known number of possible games', () => {
  const tally = { games: 0, draws: 0, X: 0, O: 0 };
  enumerate(T.empty(), 'X', tally);
  assert.deepStrictEqual(tally, { games: 255168, draws: 46080, X: 131184, O: 77904 });
});

// Let a human try EVERY possible reply against the computer, and check the computer never loses.
function neverLoses(b, turn, ai, human, tally) {
  const r = T.result(b);
  if (r) {
    tally.games++;
    assert.ok(r === 'draw' || r.who === ai, 'the computer lost a game: ' + b.join('|'));
    return;
  }
  if (turn === ai) {
    const m = T.aiMove(b, ai, 'hard', () => 0.5);
    b[m] = ai; neverLoses(b, human, ai, human, tally); b[m] = '';
  } else {
    T.moves(b).forEach((m) => { b[m] = human; neverLoses(b, ai, ai, human, tally); b[m] = ''; });
  }
}

test('the hard computer never loses, playing second against every possible human game', () => {
  const tally = { games: 0 };
  neverLoses(T.empty(), 'X', 'O', 'X', tally);
  assert.ok(tally.games > 20);
});

test('the hard computer never loses, playing first against every possible human game', () => {
  const tally = { games: 0 };
  neverLoses(T.empty(), 'X', 'X', 'O', tally);
  assert.ok(tally.games > 20);
});

test('it takes a win when it has one, and blocks when it must', () => {
  const win = ['X', 'X', '', 'O', 'O', '', '', '', ''];
  assert.strictEqual(T.aiMove(win, 'X', 'hard', () => 0.5), 2);
  const block = ['O', 'O', '', '', 'X', '', '', '', 'X'];
  assert.strictEqual(T.aiMove(block, 'X', 'hard', () => 0.5), 2);
});

test('it opens in the centre, and answers a corner opening with the centre', () => {
  assert.strictEqual(T.aiMove(T.empty(), 'X', 'hard', () => 0.5), 4);
  const b = T.empty(); b[0] = 'X';
  assert.strictEqual(T.aiMove(b, 'O', 'hard', () => 0.5), 4);
});

test('easy plays randomly, but only ever on a free cell', () => {
  const rng = seeded(8), b = ['X', '', 'O', '', 'X', '', '', '', ''];
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const m = T.aiMove(b, 'O', 'easy', rng); assert.strictEqual(b[m], ''); seen.add(m); }
  assert.ok(seen.size > 3);
});

test('medium sometimes errs and hard never does', () => {
  const win = ['X', 'X', '', 'O', 'O', '', '', '', ''];
  const rng = seeded(2); let misses = 0;
  for (let i = 0; i < 200; i++) if (T.aiMove(win, 'X', 'medium', rng) !== 2) misses++;
  assert.ok(misses > 20 && misses < 180, 'misses ' + misses);
  for (let i = 0; i < 50; i++) assert.strictEqual(T.aiMove(win, 'X', 'hard', rng), 2);
});

test('a finished board has no move to make', () => {
  assert.strictEqual(T.aiMove(['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'], 'X', 'hard', () => 0), -1);
});
done();
`;

const TTT_UI = String.raw`(function () {
  'use strict';
  var T = window.TicTacToe, kit = window.kit;
  var board, turn, over, mode = kit.load('mode', 'hard'), human = 'X';
  var score = kit.load('score', { win: 0, draw: 0, loss: 0 });
  var cellsHost = kit.$('cells'), cells = [];

  for (var i = 0; i < 9; i++) {
    (function (i) {
      var b = kit.el('button', 'tcell'); b.type = 'button'; b.setAttribute('aria-label', 'Cell ' + (i + 1));
      b.addEventListener('click', function () { play(i); });
      cellsHost.appendChild(b); cells.push(b);
    })(i);
  }

  function stats() {
    kit.stats(mode === 'two' ? [['Mode', '2 players']] : [['Mode', mode], ['You', score.win], ['Draws', score.draw], ['Computer', score.loss]]);
  }

  function paint() {
    var r = T.result(board);
    board.forEach(function (v, i) {
      cells[i].textContent = v;
      cells[i].className = 'tcell' + (v ? ' ' + v : '') + (r && r !== 'draw' && r.line.indexOf(i) >= 0 ? ' win' : '');
      cells[i].disabled = !!v || over;
    });
    var msg = kit.$('msg');
    if (r === 'draw') msg.textContent = "It's a draw.";
    else if (r) msg.textContent = (mode === 'two' ? r.who + ' wins!' : (r.who === human ? 'You win!' : 'The computer wins.'));
    else msg.textContent = mode === 'two' ? turn + ' to move.' : (turn === human ? 'Your move.' : 'Thinking...');
  }

  function finish() {
    var r = T.result(board); if (!r) return false;
    over = true;
    if (mode !== 'two') {
      if (r === 'draw') score.draw++; else if (r.who === human) score.win++; else score.loss++;
      kit.save('score', score);
    }
    stats(); paint(); return true;
  }

  function play(i) {
    if (over || board[i]) return;
    if (mode !== 'two' && turn !== human) return;
    board[i] = turn; turn = T.other(turn);
    if (finish()) return;
    paint();
    if (mode !== 'two') setTimeout(computer, 350);
  }

  function computer() {
    if (over || turn === human) return;
    var m = T.aiMove(board, turn, mode, Math.random);
    if (m >= 0) { board[m] = turn; turn = T.other(turn); }
    if (!finish()) paint();
  }

  function fresh(swap) {
    board = T.empty(); over = false; turn = 'X';
    if (swap) human = T.other(human);
    stats(); paint();
    if (mode !== 'two' && human === 'O') setTimeout(computer, 350);
  }

  var sel = kit.$('mode');
  [['hard', 'Computer: unbeatable'], ['medium', 'Computer: medium'], ['easy', 'Computer: easy'], ['two', 'Two players']].forEach(function (m) {
    var o = kit.el('option', '', m[1]); o.value = m[0]; sel.appendChild(o);
  });
  sel.value = mode;
  sel.addEventListener('change', function () { mode = sel.value; kit.save('mode', mode); fresh(false); });
  kit.$('again').addEventListener('click', function () { fresh(false); });
  kit.$('swap').addEventListener('click', function () { fresh(true); });
  fresh(false);
})();
`;

export const ticTacToeGame = webApp({
  id: 'tictactoe',
  label: 'a tic-tac-toe game',
  summary: 'tic-tac-toe against an unbeatable computer, an easier one, or a friend',
  group: 'game',
  words: ['tic tac toe', 'tic-tac-toe', 'tictactoe', 'noughts and crosses', 'naughts and crosses', 'xs and os'],
  size: [560, 700],
  body: `      <div class="row"><select id="mode" aria-label="Opponent"></select><button class="btn primary" id="again" type="button">New game</button><button class="btn" id="swap" type="button">Swap sides</button></div>
      <p class="hint" id="msg" aria-live="polite"></p>
      <div class="ttt" id="cells"></div>`,
  css: `
.ttt { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; width: min(86vw, 360px); aspect-ratio: 1; }
.tcell { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); font: 700 clamp(40px, 12vw, 76px) "Segoe UI", sans-serif; cursor: pointer; color: var(--text); }
.tcell:hover:not(:disabled) { border-color: var(--purple2); background: #1a1030; }
.tcell:disabled { cursor: default; }
.tcell.X { color: var(--purple); text-shadow: 0 0 18px var(--glow); }
.tcell.O { color: var(--gold); text-shadow: 0 0 18px rgba(251, 191, 36, 0.4); }
.tcell.win { background: #22143e; border-color: var(--good); box-shadow: 0 0 20px rgba(52, 211, 153, 0.4); }
`,
  logic: TTT_LOGIC,
  ui: TTT_UI,
  test: TTT_TEST,
});

// ------------------------------------------------------------------------------------ BREAKOUT

const BREAKOUT_LOGIC = String.raw`/*
 * {{NAME}} - the rules and physics of Breakout. Pure logic, advanced in small fixed slices so a
 * fast ball cannot pass through a brick; the only randomness is the generator you pass in.
 *
 * The field is 480 x 360 "pixels". The ball keeps one speed, which rises a little on every paddle
 * hit and level; a paddle hit sends it out at an angle set by WHERE on the paddle it landed, from
 * -60 degrees at the left end to +60 at the right.
 */
(function (root) {
  'use strict';

  var W = 480, H = 360, MAX_ANGLE = Math.PI / 3, SLICE = 1 / 240;
  var PADDLE_W = 76, PADDLE_H = 10, BALL_R = 6, COLS = 10, GAP = 4, MARGIN = 20, TOP = 40, BRICK_H = 16;

  function levelBricks(level) {
    var rows = Math.min(3 + level, 8), bw = (W - 2 * MARGIN - (COLS - 1) * GAP) / COLS, bricks = [];
    for (var r = 0; r < rows; r++) for (var c = 0; c < COLS; c++) {
      bricks.push({ x: MARGIN + c * (bw + GAP), y: TOP + r * (BRICK_H + GAP), w: bw, h: BRICK_H, row: r, hp: level >= 2 && r < Math.floor(level / 2) ? 2 : 1, alive: true });
    }
    return bricks;
  }

  function baseSpeed(level) { return Math.min(230 + level * 25, 420); }

  function create(level, carry) {
    level = level || 1;
    var s = {
      w: W, h: H, level: level,
      paddle: { x: W / 2 - PADDLE_W / 2, y: H - 26, w: PADDLE_W, h: PADDLE_H },
      ball: { x: W / 2, y: H - 26 - BALL_R, vx: 0, vy: 0, r: BALL_R },
      bricks: levelBricks(level),
      lives: carry ? carry.lives : 3, score: carry ? carry.score : 0,
      speed: baseSpeed(level), status: 'serve'
    };
    return s;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function movePaddle(s, centerX) {
    s.paddle.x = clamp(centerX - s.paddle.w / 2, 0, W - s.paddle.w);
    if (s.status === 'serve') s.ball.x = s.paddle.x + s.paddle.w / 2;
  }

  function launch(s, rng) {
    if (s.status !== 'serve') return false;
    var angle = (rng() * 2 - 1) * (Math.PI / 6);            // up to 30 degrees either side of straight up
    s.ball.vx = s.speed * Math.sin(angle); s.ball.vy = -s.speed * Math.cos(angle);
    s.status = 'playing';
    return true;
  }

  function setSpeed(b, speed, angle) { b.vx = speed * Math.sin(angle); b.vy = -speed * Math.cos(angle); }

  function slice(s, dt) {
    var b = s.ball, p = s.paddle;
    b.x += b.vx * dt; b.y += b.vy * dt;

    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }
    if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); }

    // The paddle: only from above, and the hit position sets the outgoing angle.
    if (b.vy > 0 && b.y + b.r >= p.y && b.y - b.r <= p.y + p.h && b.x >= p.x - b.r && b.x <= p.x + p.w + b.r) {
      var rel = clamp((b.x - (p.x + p.w / 2)) / (p.w / 2), -1, 1);
      s.speed = Math.min(s.speed * 1.015, baseSpeed(s.level) * 1.5);
      setSpeed(b, s.speed, rel * MAX_ANGLE);
      b.y = p.y - b.r;
    }

    // Bricks: the circle against each box. The side with the least overlap decides which way it bounces.
    for (var i = 0; i < s.bricks.length; i++) {
      var k = s.bricks[i];
      if (!k.alive) continue;
      var nx = clamp(b.x, k.x, k.x + k.w), ny = clamp(b.y, k.y, k.y + k.h);
      var dx = b.x - nx, dy = b.y - ny;
      if (dx * dx + dy * dy > b.r * b.r) continue;
      var cx = k.x + k.w / 2, cy = k.y + k.h / 2;
      var overlapX = (k.w / 2 + b.r) - Math.abs(b.x - cx), overlapY = (k.h / 2 + b.r) - Math.abs(b.y - cy);
      if (overlapX < overlapY) { b.vx = (b.x < cx ? -1 : 1) * Math.abs(b.vx); b.x += (b.x < cx ? -1 : 1) * overlapX; }
      else { b.vy = (b.y < cy ? -1 : 1) * Math.abs(b.vy); b.y += (b.y < cy ? -1 : 1) * overlapY; }
      k.hp -= 1;
      if (k.hp <= 0) { k.alive = false; s.score += 10 * (1 + (s.bricks.length > 0 ? Math.floor((7 - Math.min(k.row, 7)) / 2) : 0)); }
      else s.score += 2;
      break;                                        // one brick per slice keeps the bounce clean
    }

    if (s.bricks.every(function (x) { return !x.alive; })) { s.status = 'cleared'; return; }

    if (b.y - b.r > H) {                            // fell past the paddle
      s.lives -= 1;
      if (s.lives <= 0) { s.status = 'lost'; return; }
      s.status = 'serve'; b.vx = 0; b.vy = 0;
      b.x = p.x + p.w / 2; b.y = p.y - b.r;
    }
  }

  // Advance by dt seconds, in slices small enough that nothing tunnels.
  function step(s, dt) {
    if (s.status === 'serve') { s.ball.x = s.paddle.x + s.paddle.w / 2; s.ball.y = s.paddle.y - s.ball.r; return s; }
    if (s.status !== 'playing') return s;
    var left = Math.min(dt, 0.05);
    while (left > 1e-9 && s.status === 'playing') { var d = Math.min(SLICE, left); slice(s, d); left -= d; }
    return s;
  }

  function nextLevel(s) { return create(s.level + 1, { lives: s.lives, score: s.score }); }

  var api = { create: create, movePaddle: movePaddle, launch: launch, step: step, nextLevel: nextLevel, W: W, H: H, baseSpeed: baseSpeed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Breakout = api;
})(typeof window !== 'undefined' ? window : this);
`;

const BREAKOUT_TEST = String.raw`
const B = require('./logic.js');

function playing(overrides) {
  const s = B.create(1);
  s.status = 'playing';
  Object.assign(s.ball, overrides);
  return s;
}
const speedOf = (b) => Math.hypot(b.vx, b.vy);

test('a fresh game waits for the serve with the ball on the paddle', () => {
  const s = B.create(1);
  assert.strictEqual(s.status, 'serve');
  assert.strictEqual(s.lives, 3);
  B.movePaddle(s, 100);
  assert.ok(Math.abs(s.ball.x - (s.paddle.x + s.paddle.w / 2)) < 1e-9);
  assert.ok(B.launch(s, () => 0.5));
  assert.strictEqual(s.status, 'playing');
  assert.ok(s.ball.vy < 0, 'it goes up');
  assert.ok(Math.abs(speedOf(s.ball) - s.speed) < 1e-6);
});

test('the paddle cannot leave the field', () => {
  const s = B.create(1);
  B.movePaddle(s, -500); assert.strictEqual(s.paddle.x, 0);
  B.movePaddle(s, 5000); assert.ok(Math.abs(s.paddle.x + s.paddle.w - B.W) < 1e-9);
});

test('the walls and ceiling bounce the ball', () => {
  let s = playing({ x: 3, y: 200, vx: -200, vy: 0 }); B.step(s, 0.05); assert.ok(s.ball.vx > 0);
  s = playing({ x: B.W - 3, y: 200, vx: 200, vy: 0 }); B.step(s, 0.05); assert.ok(s.ball.vx < 0);
  s = playing({ x: 240, y: 3, vx: 0, vy: -200 }); B.step(s, 0.05); assert.ok(s.ball.vy > 0);
});

test('the middle of the paddle sends the ball straight up, the ends send it out at an angle', () => {
  const hit = (x) => {
    const s = playing({ x, y: B.create(1).paddle.y - 8, vx: 0, vy: 240 });
    s.paddle.x = 240 - s.paddle.w / 2;
    B.step(s, 0.03);
    return s.ball;
  };
  const mid = hit(240), left = hit(240 - 34), right = hit(240 + 34);
  assert.ok(mid.vy < 0 && Math.abs(mid.vx) < 5, 'centre goes straight up');
  assert.ok(left.vx < -50 && left.vy < 0, 'left end goes left');
  assert.ok(right.vx > 50 && right.vy < 0, 'right end goes right');
});

test('a brick breaks, scores, and sends the ball back', () => {
  const s = B.create(1);
  const brick = s.bricks[s.bricks.length - 1];       // the lowest row, so nothing else is in the way
  s.status = 'playing';
  Object.assign(s.ball, { x: brick.x + brick.w / 2, y: brick.y + brick.h + 10, vx: 0, vy: -240 });
  const before = s.bricks.filter((b) => b.alive).length;
  for (let i = 0; i < 20; i++) B.step(s, 0.02);
  assert.strictEqual(brick.alive, false);
  assert.strictEqual(s.bricks.filter((b) => b.alive).length, before - 1);
  assert.ok(s.score >= 10);
  assert.ok(s.ball.vy > 0, 'it bounced back down');
});

test('tougher bricks take two hits', () => {
  const s = B.create(4);
  const tough = s.bricks.find((b) => b.hp === 2);
  assert.ok(tough, 'higher levels have two-hit bricks');
  tough.hp -= 1;
  assert.strictEqual(tough.alive, true);
});

test('missing the ball costs a life and goes back to the serve; the last life ends the game', () => {
  const s = playing({ x: 20, y: B.H + 20, vx: 0, vy: 100 });
  B.step(s, 0.01);
  assert.strictEqual(s.lives, 2);
  assert.strictEqual(s.status, 'serve');
  s.lives = 1; s.status = 'playing'; Object.assign(s.ball, { x: 20, y: B.H + 20, vx: 0, vy: 100 });
  B.step(s, 0.01);
  assert.strictEqual(s.status, 'lost');
});

test('clearing every brick ends the level, and the next one is harder and keeps score and lives', () => {
  const s = B.create(1);
  s.bricks.forEach((b) => { b.alive = false; });
  s.bricks[0].alive = true;
  const k = s.bricks[0];
  s.status = 'playing'; s.score = 120; s.lives = 2;
  Object.assign(s.ball, { x: k.x + k.w / 2, y: k.y + k.h + 8, vx: 0, vy: -240 });
  for (let i = 0; i < 20 && s.status === 'playing'; i++) B.step(s, 0.02);
  assert.strictEqual(s.status, 'cleared');
  const n = B.nextLevel(s);
  assert.strictEqual(n.level, 2);
  assert.strictEqual(n.lives, 2);
  assert.ok(n.score >= 120);
  assert.ok(n.speed > s.speed - 1);
  assert.ok(n.bricks.length > s.bricks.length);
});

test('a fast ball cannot tunnel through a brick', () => {
  const s = B.create(1);
  const k = s.bricks[s.bricks.length - 1];
  s.status = 'playing';
  Object.assign(s.ball, { x: k.x + k.w / 2, y: k.y + k.h + 60, vx: 0, vy: -1400 });
  B.step(s, 0.05);
  assert.strictEqual(k.alive, false);
});

test('over many thousands of steps the ball stays in the field and keeps a sane speed', () => {
  const rng = seeded(31);
  let s = B.create(3);
  B.launch(s, rng);
  for (let i = 0; i < 40000; i++) {
    if (i % 7 === 0) B.movePaddle(s, s.ball.x + (rng() - 0.5) * 60);   // a paddle that mostly tracks the ball
    B.step(s, 1 / 60);
    const b = s.ball;
    assert.ok(b.x >= -1 && b.x <= B.W + 1 && b.y >= -1 && b.y <= B.H + 60, 'ball in bounds');
    if (s.status === 'playing') assert.ok(speedOf(b) < s.speed * 1.02 + 1 && speedOf(b) > s.speed * 0.98 - 1, 'speed ' + speedOf(b));
    if (s.status === 'serve') B.launch(s, rng);
    if (s.status === 'cleared') s = B.nextLevel(s);
    if (s.status === 'lost') { s = B.create(1); B.launch(s, rng); }
  }
});
done();
`;

const BREAKOUT_UI = String.raw`(function () {
  'use strict';
  var B = window.Breakout, kit = window.kit;
  var canvas = kit.$('board'), ctx = canvas.getContext('2d');
  var state, paused = false, last = 0, best = kit.load('best', 0), raf = 0;
  var ROW_COLORS = ['#f472b6', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#a855f7', '#c084fc'];

  function size() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = B.W * dpr; canvas.height = B.H * dpr;
    canvas.style.width = B.W * 1.6 + 'px'; canvas.style.height = B.H * 1.6 + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    ctx.fillStyle = '#0a0613'; ctx.fillRect(0, 0, B.W, B.H);
    state.bricks.forEach(function (k) {
      if (!k.alive) return;
      ctx.fillStyle = ROW_COLORS[k.row % ROW_COLORS.length];
      ctx.globalAlpha = k.hp > 1 ? 1 : 0.82;
      ctx.fillRect(k.x, k.y, k.w, k.h);
      if (k.hp > 1) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(k.x + 1, k.y + 1, k.w - 2, k.h - 2); }
      ctx.globalAlpha = 1;
    });
    var p = state.paddle;
    ctx.fillStyle = '#e9d5ff'; ctx.shadowColor = '#a855f7'; ctx.shadowBlur = 12;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, state.ball.r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  function stats() {
    if (state.score > best) { best = state.score; kit.save('best', best); }
    kit.stats([['Score', state.score], ['Lives', state.lives], ['Level', state.level], ['Best', best]]);
  }

  function overlay(title, sub, show) {
    kit.$('title').textContent = title; kit.$('sub').textContent = sub; kit.$('overlay').hidden = !show;
  }

  function loop(t) {
    var dt = last ? (t - last) / 1000 : 0; last = t;
    if (!paused) {
      B.step(state, dt);
      if (state.status === 'cleared') overlay('Level ' + state.level + ' cleared', 'Click or press Space for the next level.', true);
      else if (state.status === 'lost') overlay('Game over', 'Score ' + state.score + '. Click or press Space to play again.', true);
      else if (state.status === 'serve' && kit.$('overlay').hidden) { /* waiting for the serve */ }
    }
    stats(); draw();
    raf = requestAnimationFrame(loop);
  }

  function action() {
    if (state.status === 'cleared') { state = B.nextLevel(state); overlay('', '', false); }
    else if (state.status === 'lost') { state = B.create(1); overlay('', '', false); }
    else if (state.status === 'serve') { overlay('', '', false); B.launch(state, Math.random); }
  }

  function fromPointer(e) {
    var r = canvas.getBoundingClientRect();
    B.movePaddle(state, (e.clientX - r.left) / r.width * B.W);
  }
  canvas.addEventListener('pointermove', fromPointer);
  canvas.addEventListener('pointerdown', function (e) { fromPointer(e); action(); });

  var held = {};
  document.addEventListener('keydown', function (e) {
    if (kit.typing(e)) return;
    if (e.key === 'ArrowLeft' || e.key === 'a') held.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd') held.right = true;
    else if (e.key === ' ') { e.preventDefault(); action(); }
    else if (e.key === 'p' || e.key === 'P') { paused = !paused; overlay('Paused', 'Press P to carry on.', paused); }
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'a') held.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd') held.right = false;
  });
  setInterval(function () {
    if (held.left) B.movePaddle(state, state.paddle.x + state.paddle.w / 2 - 12);
    if (held.right) B.movePaddle(state, state.paddle.x + state.paddle.w / 2 + 12);
  }, 16);

  kit.buttons(kit.$('controls'), [['New game', function () { state = B.create(1); overlay('', '', false); }, 'primary']]);
  size();
  state = B.create(1);
  overlay('Breakout', 'Move the mouse or use the arrow keys. Click or press Space to serve.', true);
  kit.$('startbtn').addEventListener('click', function () { overlay('', '', false); });
  raf = requestAnimationFrame(loop);
})();
`;

export const breakoutGame = webApp({
  id: 'breakout',
  label: 'a breakout game',
  summary: 'Breakout: bounce the ball off the paddle and clear the bricks, level after level',
  group: 'game',
  words: ['breakout', 'brick breaker', 'arkanoid', 'brick game', 'bricks game'],
  size: [860, 760],
  body: `      <div class="stage">
        <canvas id="board" aria-label="Breakout"></canvas>
        <div class="overlay" id="overlay"><h3 id="title"></h3><p class="hint" id="sub"></p><button class="btn primary" id="startbtn" type="button">Play</button></div>
      </div>
      <div class="row" id="controls"></div>
      <p class="hint">Mouse or arrow keys to move. Space or click to serve. P pauses.</p>`,
  css: '',
  logic: BREAKOUT_LOGIC,
  ui: BREAKOUT_UI,
  test: BREAKOUT_TEST,
});
