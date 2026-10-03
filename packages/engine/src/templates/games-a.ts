/** Snake, 2048 and Minesweeper. Each is rules (pure, tested) + a page that draws them. */

import { webApp } from './web-app';

// ------------------------------------------------------------------------------------ SNAKE

const SNAKE_LOGIC = String.raw`/*
 * {{NAME}} - the rules of Snake. Pure logic: no screen, no timers, and the only randomness is the
 * generator you hand in, so the same seed always plays the same game (test.js relies on it).
 */
(function (root) {
  'use strict';

  var DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

  function create(opts) {
    opts = opts || {};
    var cols = opts.cols || 20, rows = opts.rows || 20;
    var cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
    var s = {
      cols: cols, rows: rows, wrap: !!opts.wrap,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }],
      dir: 'right', queued: [], food: null, score: 0, alive: true, won: false, ticks: 0
    };
    placeFood(s, opts.rng || Math.random);
    return s;
  }

  function isOpposite(a, b) { return DIRS[a].x + DIRS[b].x === 0 && DIRS[a].y + DIRS[b].y === 0; }

  // Up to two turns can wait, so two quick taps inside one tick both count and neither can reverse.
  function turn(s, d) {
    if (!DIRS[d] || !s.alive) return false;
    var last = s.queued.length ? s.queued[s.queued.length - 1] : s.dir;
    if (d === last || isOpposite(last, d) || s.queued.length >= 2) return false;
    s.queued.push(d);
    return true;
  }

  function occupies(s, x, y) {
    for (var i = 0; i < s.snake.length; i++) if (s.snake[i].x === x && s.snake[i].y === y) return true;
    return false;
  }

  // Food goes on a uniformly random FREE cell. A full board is a win.
  function placeFood(s, rng) {
    var free = [];
    for (var y = 0; y < s.rows; y++) for (var x = 0; x < s.cols; x++) if (!occupies(s, x, y)) free.push({ x: x, y: y });
    if (!free.length) { s.food = null; s.won = true; s.alive = false; return false; }
    s.food = free[Math.floor(rng() * free.length) % free.length];
    return true;
  }

  function step(s, rng) {
    if (!s.alive) return s;
    if (s.queued.length) s.dir = s.queued.shift();
    var d = DIRS[s.dir], head = s.snake[0], nx = head.x + d.x, ny = head.y + d.y;
    if (s.wrap) { nx = (nx + s.cols) % s.cols; ny = (ny + s.rows) % s.rows; }
    else if (nx < 0 || ny < 0 || nx >= s.cols || ny >= s.rows) { s.alive = false; return s; }
    var eating = !!s.food && nx === s.food.x && ny === s.food.y;
    // The tail steps out of the way this tick unless the snake is growing, so its cell is safe.
    var body = eating ? s.snake : s.snake.slice(0, -1);
    for (var i = 0; i < body.length; i++) if (body[i].x === nx && body[i].y === ny) { s.alive = false; return s; }
    s.snake.unshift({ x: nx, y: ny });
    if (eating) { s.score += 1; placeFood(s, rng || Math.random); } else s.snake.pop();
    s.ticks += 1;
    return s;
  }

  // Milliseconds per move: it speeds up with the score and never gets faster than 60.
  function tickMs(s) { return Math.max(60, 140 - s.score * 3); }

  var api = { create: create, turn: turn, step: step, tickMs: tickMs, placeFood: placeFood, DIRS: DIRS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Snake = api;
})(typeof window !== 'undefined' ? window : this);
`;

const SNAKE_TEST = String.raw`
const S = require('./logic.js');

test('the snake moves one cell a tick and keeps its length', () => {
  const s = S.create({ rng: () => 0 });
  const head = s.snake[0];
  S.step(s, () => 0);
  assert.deepStrictEqual(s.snake[0], { x: head.x + 1, y: head.y });
  assert.strictEqual(s.snake.length, 3);
});

test('eating grows it, scores, and puts new food somewhere free', () => {
  const s = S.create({ rng: () => 0 });
  s.food = { x: s.snake[0].x + 1, y: s.snake[0].y };
  S.step(s, seeded(1));
  assert.strictEqual(s.snake.length, 4);
  assert.strictEqual(s.score, 1);
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y));
});

test('a wall ends the game, unless the walls wrap', () => {
  const walled = S.create({ cols: 5, rows: 5, rng: () => 0 });
  for (let i = 0; i < 4; i++) S.step(walled, () => 0);
  assert.strictEqual(walled.alive, false);
  const wrapped = S.create({ cols: 5, rows: 5, wrap: true, rng: () => 0 });
  for (let i = 0; i < 20; i++) S.step(wrapped, () => 0);
  assert.strictEqual(wrapped.alive, true);
});

test('you cannot turn straight back into yourself', () => {
  const s = S.create({ rng: () => 0 });
  assert.strictEqual(S.turn(s, 'left'), false);
  assert.strictEqual(S.turn(s, 'right'), false);
  assert.strictEqual(S.turn(s, 'up'), true);
  assert.strictEqual(S.turn(s, 'down'), false);   // down would reverse the queued up
  assert.strictEqual(S.turn(s, 'left'), true);    // up then left within one tick is fine
});

test('two quick turns inside one tick are both kept, a third is not', () => {
  const s = S.create({ rng: () => 0 });
  S.turn(s, 'up'); S.turn(s, 'left');
  assert.strictEqual(S.turn(s, 'down'), false);
  S.step(s, () => 0); assert.strictEqual(s.dir, 'up');
  S.step(s, () => 0); assert.strictEqual(s.dir, 'left');
});

test('running into your own body ends the game', () => {
  const s = S.create({ rng: () => 0 });
  s.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 4 }, { x: 5, y: 4 }];
  s.dir = 'up'; s.food = { x: 0, y: 0 };
  S.turn(s, 'left');
  S.step(s, () => 0);
  assert.strictEqual(s.alive, false);
});

test('the tail cell is free to move into, because the tail moves away', () => {
  const s = S.create({ cols: 2, rows: 2, rng: () => 0 });
  s.snake = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }];
  s.dir = 'right'; s.food = null; s.alive = true;
  S.step(s, () => 0);
  assert.strictEqual(s.alive, true);
});

test('a full board is a win', () => {
  const s = S.create({ cols: 3, rows: 1, rng: () => 0 });
  s.snake = [{ x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
  assert.strictEqual(S.placeFood(s, () => 0), false);
  assert.strictEqual(s.won, true);
  assert.strictEqual(s.alive, false);
});

test('whatever it does, the snake stays tidy for a thousand moves', () => {
  const rng = seeded(7);
  const s = S.create({ cols: 12, rows: 12, wrap: true, rng });
  const dirs = ['up', 'down', 'left', 'right'];
  for (let i = 0; i < 1000 && s.alive; i++) {
    if (rng() < 0.3) S.turn(s, dirs[Math.floor(rng() * 4)]);
    S.step(s, rng);
    const seen = new Set(s.snake.map((c) => c.x + ',' + c.y));
    assert.strictEqual(seen.size, s.snake.length, 'no two segments share a cell');
    assert.strictEqual(s.snake.length, 3 + s.score);
    assert.ok(s.snake.every((c) => c.x >= 0 && c.y >= 0 && c.x < 12 && c.y < 12));
    if (s.food) assert.ok(!seen.has(s.food.x + ',' + s.food.y), 'food is never inside the snake');
  }
});

test('it speeds up with the score and never past the limit', () => {
  const s = S.create({ rng: () => 0 });
  const slow = S.tickMs(s);
  s.score = 10; assert.ok(S.tickMs(s) < slow);
  s.score = 500; assert.strictEqual(S.tickMs(s), 60);
});
done();
`;

const SNAKE_UI = String.raw`(function () {
  'use strict';
  var Snake = window.Snake, kit = window.kit;
  var CELL = 24, COLS = 20, ROWS = 20;
  var canvas = kit.$('board'), ctx = canvas.getContext('2d');
  var state, paused = false, timer = 0, started = false;
  var best = kit.load('best', 0), wrap = kit.load('wrap', false);

  function size() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = COLS * CELL * dpr; canvas.height = ROWS * CELL * dpr;
    canvas.style.width = COLS * CELL + 'px'; canvas.style.height = ROWS * CELL + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    ctx.fillStyle = '#0a0613'; ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
    ctx.strokeStyle = 'rgba(168,85,247,0.07)'; ctx.lineWidth = 1;
    for (var i = 1; i < COLS; i++) { ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, ROWS * CELL); ctx.stroke(); }
    for (var j = 1; j < ROWS; j++) { ctx.beginPath(); ctx.moveTo(0, j * CELL); ctx.lineTo(COLS * CELL, j * CELL); ctx.stroke(); }
    if (state.food) {
      ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 14; ctx.fillStyle = '#fbbf24';
      ctx.beginPath(); ctx.arc(state.food.x * CELL + CELL / 2, state.food.y * CELL + CELL / 2, CELL * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    state.snake.forEach(function (c, k) {
      var t = 1 - k / Math.max(state.snake.length, 1) * 0.55;
      ctx.fillStyle = k === 0 ? '#e9d5ff' : 'rgba(168,85,247,' + t.toFixed(2) + ')';
      ctx.shadowColor = '#a855f7'; ctx.shadowBlur = k === 0 ? 12 : 4;
      ctx.beginPath();
      var r = 6, x = c.x * CELL + 2, y = c.y * CELL + 2, w = CELL - 4;
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + w, r); ctx.arcTo(x + w, y + w, x, y + w, r);
      ctx.arcTo(x, y + w, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill();
    });
    ctx.shadowBlur = 0;
  }

  function stats() { kit.stats([['Score', state.score], ['Best', best], ['Walls', wrap ? 'wrap' : 'solid']]); }

  function overlay(title, sub, show) {
    kit.$('title').textContent = title; kit.$('sub').textContent = sub;
    kit.$('overlay').hidden = !show;
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(tick, Snake.tickMs(state)); }

  function tick() {
    if (paused || !state.alive) return;
    Snake.step(state, Math.random);
    if (state.score > best) { best = state.score; kit.save('best', best); }
    stats(); draw();
    if (!state.alive) { overlay(state.won ? 'You filled the board!' : 'Game over', 'Score ' + state.score + '. Press Enter to play again.', true); return; }
    schedule();
  }

  function start() {
    state = Snake.create({ cols: COLS, rows: ROWS, wrap: wrap, rng: Math.random });
    paused = false; started = true;
    overlay('', '', false); stats(); draw(); schedule();
  }

  function togglePause() {
    if (!started || !state.alive) return;
    paused = !paused;
    overlay('Paused', 'Press Space to carry on.', paused);
    if (!paused) schedule();
  }

  var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
  document.addEventListener('keydown', function (e) {
    if (kit.typing(e)) return;
    if (KEYS[e.key]) {
      e.preventDefault();
      if (!started) start();
      Snake.turn(state, KEYS[e.key]);
    } else if (e.key === ' ') { e.preventDefault(); if (!started) start(); else togglePause(); }
    else if (e.key === 'Enter') { e.preventDefault(); start(); }
  });

  // Swipes work too.
  var sx = 0, sy = 0;
  canvas.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; });
  canvas.addEventListener('pointerup', function (e) {
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (!started) start();
    Snake.turn(state, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });

  kit.buttons(kit.$('controls'), [
    ['New game', start, 'primary'],
    ['Pause', togglePause],
    ['Walls: solid / wrap', function () { wrap = !wrap; kit.save('wrap', wrap); start(); }]
  ]);
  kit.$('startbtn').addEventListener('click', start);

  size();
  state = Snake.create({ cols: COLS, rows: ROWS, wrap: wrap, rng: Math.random });
  stats(); draw();
  overlay('Snake', 'Arrow keys or WASD to move. Eat the gold, never hit a wall or yourself.', true);
})();
`;

export const snakeGame = webApp({
  id: 'snake',
  label: 'a snake game',
  summary: 'the classic Snake: eat, grow, speed up, keep your best score',
  group: 'game',
  words: ['snake'],
  size: [620, 760],
  body: `      <div class="stage">
        <canvas id="board" aria-label="Snake board"></canvas>
        <div class="overlay" id="overlay"><h3 id="title"></h3><p class="hint" id="sub"></p><button class="btn primary" id="startbtn" type="button">Play</button></div>
      </div>
      <div class="row" id="controls"></div>
      <p class="hint">Arrow keys or WASD. Space pauses. Swipe on a touch screen.</p>`,
  css: '',
  logic: SNAKE_LOGIC,
  ui: SNAKE_UI,
  test: SNAKE_TEST,
});

// ------------------------------------------------------------------------------------ 2048

const G2048_LOGIC = String.raw`/*
 * {{NAME}} - the rules of 2048. Pure logic; the only randomness is the generator you pass in.
 *
 * A board is 4 rows of 4 numbers (0 = empty). Every move is "slide a line left" applied to the
 * board turned so the move points left, then turned back; that one idea covers all four directions.
 */
(function (root) {
  'use strict';
  var SIZE = 4;

  // Slide one line toward index 0. Each tile merges at most once per move: [2,2,2,2] -> [4,4,0,0].
  function slideLine(line) {
    var tiles = line.filter(function (v) { return v !== 0; });
    var out = [], gained = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) { out.push(tiles[i] * 2); gained += tiles[i] * 2; i++; }
      else out.push(tiles[i]);
    }
    while (out.length < line.length) out.push(0);
    var moved = out.some(function (v, k) { return v !== line[k]; });
    return { line: out, gained: gained, moved: moved };
  }

  function rotate(board) {          // clockwise
    var n = board.length, r = [];
    for (var y = 0; y < n; y++) { r.push([]); for (var x = 0; x < n; x++) r[y].push(board[n - 1 - x][y]); }
    return r;
  }
  function copy(board) { return board.map(function (row) { return row.slice(); }); }

  // dir: 'left' | 'right' | 'up' | 'down'. Returns a NEW board; the input is untouched.
  function move(board, dir) {
    var turns = { left: 0, down: 1, right: 2, up: 3 }[dir];
    if (turns === undefined) throw new Error('unknown direction ' + dir);
    var b = copy(board), i;
    for (i = 0; i < turns; i++) b = rotate(b);
    var gained = 0, moved = false;
    b = b.map(function (row) { var r = slideLine(row); gained += r.gained; moved = moved || r.moved; return r.line; });
    for (i = 0; i < (4 - turns) % 4; i++) b = rotate(b);
    return { board: b, gained: gained, moved: moved };
  }

  function empties(board) {
    var cells = [];
    board.forEach(function (row, y) { row.forEach(function (v, x) { if (v === 0) cells.push({ x: x, y: y }); }); });
    return cells;
  }

  // 90% a 2, 10% a 4, on a random empty cell. Returns the cell, or null if there is no room.
  function spawn(board, rng) {
    var cells = empties(board);
    if (!cells.length) return null;
    var c = cells[Math.floor(rng() * cells.length) % cells.length];
    board[c.y][c.x] = rng() < 0.9 ? 2 : 4;
    return c;
  }

  function canMove(board) {
    if (empties(board).length) return true;
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (x + 1 < SIZE && board[y][x] === board[y][x + 1]) return true;
      if (y + 1 < SIZE && board[y][x] === board[y + 1][x]) return true;
    }
    return false;
  }

  function biggest(board) { return Math.max.apply(null, board.map(function (r) { return Math.max.apply(null, r); })); }

  function create(rng) {
    var board = [];
    for (var y = 0; y < SIZE; y++) board.push([0, 0, 0, 0]);
    spawn(board, rng); spawn(board, rng);
    return { board: board, score: 0, won: false, keepPlaying: false, over: false, moves: 0 };
  }

  // One turn: slide, and if anything moved, add a tile. Returns what changed so the page can animate.
  function play(state, dir, rng) {
    if (state.over) return { moved: false };
    var r = move(state.board, dir);
    if (!r.moved) return { moved: false };
    state.board = r.board; state.score += r.gained; state.moves += 1;
    var tile = spawn(state.board, rng);
    if (!state.won && biggest(state.board) >= 2048) state.won = true;
    if (!canMove(state.board)) state.over = true;
    return { moved: true, gained: r.gained, spawned: tile };
  }

  var api = { slideLine: slideLine, move: move, spawn: spawn, canMove: canMove, create: create, play: play, biggest: biggest, SIZE: SIZE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.G2048 = api;
})(typeof window !== 'undefined' ? window : this);
`;

const G2048_TEST = String.raw`
const G = require('./logic.js');

test('lines slide and merge the way the game says they do', () => {
  const cases = [
    [[2, 2, 2, 2], [4, 4, 0, 0], 8],
    [[2, 2, 2, 0], [4, 2, 0, 0], 4],
    [[4, 2, 2, 0], [4, 4, 0, 0], 4],
    [[2, 0, 0, 2], [4, 0, 0, 0], 4],
    [[0, 0, 0, 0], [0, 0, 0, 0], 0],
    [[0, 2, 0, 4], [2, 4, 0, 0], 0],
    [[8, 8, 16, 16], [16, 32, 0, 0], 48],
  ];
  cases.forEach(([input, out, gained]) => {
    const r = G.slideLine(input);
    assert.deepStrictEqual(r.line, out, JSON.stringify(input));
    assert.strictEqual(r.gained, gained);
  });
});

test('a line that cannot change reports that nothing moved', () => {
  assert.strictEqual(G.slideLine([2, 4, 2, 4]).moved, false);
  assert.strictEqual(G.slideLine([2, 4, 0, 0]).moved, false);
  assert.strictEqual(G.slideLine([0, 2, 4, 0]).moved, true);
});

test('all four directions agree with each other on a mirrored board', () => {
  const b = [[2, 2, 0, 0], [0, 0, 4, 4], [2, 0, 0, 2], [0, 8, 8, 0]];
  const left = G.move(b, 'left').board;
  assert.deepStrictEqual(left, [[4, 0, 0, 0], [8, 0, 0, 0], [4, 0, 0, 0], [16, 0, 0, 0]]);
  assert.deepStrictEqual(G.move(b, 'right').board, [[0, 0, 0, 4], [0, 0, 0, 8], [0, 0, 0, 4], [0, 0, 0, 16]]);
  const up = G.move(b, 'up').board;
  assert.deepStrictEqual(up[0], [4, 2, 4, 4]);
  const down = G.move(b, 'down').board;
  assert.deepStrictEqual(down[3], [4, 8, 8, 2]);
});

test('moving never changes the board you passed in', () => {
  const b = [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const snapshot = JSON.stringify(b);
  G.move(b, 'left');
  assert.strictEqual(JSON.stringify(b), snapshot);
});

test('a move that changes nothing adds no tile and costs no move', () => {
  const rng = seeded(3);
  const s = G.create(rng);
  s.board = [[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const r = G.play(s, 'left', rng);
  assert.strictEqual(r.moved, false);
  assert.strictEqual(s.moves, 0);
  assert.strictEqual(s.board.flat().filter((v) => v).length, 4);
});

test('a move that works adds exactly one tile, a 2 or a 4', () => {
  const rng = seeded(11);
  const s = G.create(rng);
  const before = s.board.flat().filter((v) => v).length;
  assert.strictEqual(before, 2);
  s.board = [[0, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const r = G.play(s, 'left', rng);
  assert.strictEqual(r.moved, true);
  assert.strictEqual(s.board.flat().filter((v) => v).length, 2);
  assert.ok([2, 4].includes(s.board[r.spawned.y][r.spawned.x]));
});

test('about nine in ten new tiles are a 2', () => {
  const rng = seeded(5);
  let twos = 0;
  for (let i = 0; i < 2000; i++) {
    const b = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const c = G.spawn(b, rng);
    if (b[c.y][c.x] === 2) twos++;
  }
  assert.ok(twos > 1700 && twos < 1900, 'twos: ' + twos);
});

test('the game is lost only when the board is full and nothing can merge', () => {
  assert.strictEqual(G.canMove([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]), false);
  assert.strictEqual(G.canMove([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 4]]), true);
  assert.strictEqual(G.canMove([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 0]]), true);
});

test('reaching 2048 wins, and play can carry on afterwards', () => {
  const rng = seeded(9);
  const s = G.create(rng);
  s.board = [[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  G.play(s, 'left', rng);
  assert.strictEqual(s.won, true);
  assert.strictEqual(s.over, false);
  assert.ok(s.score >= 2048);
});

test('a random player never breaks the board', () => {
  const rng = seeded(21);
  const s = G.create(rng);
  const dirs = ['left', 'right', 'up', 'down'];
  for (let i = 0; i < 3000 && !s.over; i++) {
    G.play(s, dirs[Math.floor(rng() * 4)], rng);
    s.board.forEach((row) => row.forEach((v) => assert.ok(v === 0 || (v & (v - 1)) === 0, 'every tile is a power of two')));
  }
  assert.ok(s.moves > 20);
});
done();
`;

const G2048_UI = String.raw`(function () {
  'use strict';
  var G = window.G2048, kit = window.kit;
  var state, best = kit.load('best', 0), previous = null;
  var grid = kit.$('grid');
  var cells = [];
  for (var i = 0; i < 16; i++) { var c = kit.el('div', 'tile'); grid.appendChild(c); cells.push(c); }

  function render() {
    state.board.forEach(function (row, y) {
      row.forEach(function (v, x) {
        var c = cells[y * 4 + x];
        var changed = previous && previous[y][x] !== v && v !== 0;
        c.textContent = v === 0 ? '' : String(v);
        c.className = 'tile t' + (v > 2048 ? 'big' : v) + (changed ? ' pop' : '');
      });
    });
    if (state.score > best) { best = state.score; kit.save('best', best); }
    kit.stats([['Score', state.score], ['Best', best], ['Moves', state.moves]]);
    var msg = kit.$('msg');
    if (state.over) { msg.hidden = false; kit.$('title').textContent = 'No moves left'; kit.$('sub').textContent = 'Final score ' + state.score; }
    else if (state.won && !state.keepPlaying) { msg.hidden = false; kit.$('title').textContent = 'You made 2048!'; kit.$('sub').textContent = 'Keep going for a higher score.'; }
    else msg.hidden = true;
  }

  function snapshot() { return state.board.map(function (r) { return r.slice(); }); }
  function go(dir) {
    if (state.over) return;
    if (state.won && !state.keepPlaying) return;
    previous = snapshot();
    var r = G.play(state, dir, Math.random);
    if (r.moved) render();
  }
  function fresh() { state = G.create(Math.random); previous = null; render(); }

  var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
  document.addEventListener('keydown', function (e) {
    if (kit.typing(e) || !KEYS[e.key]) return;
    e.preventDefault(); go(KEYS[e.key]);
  });
  var sx = 0, sy = 0;
  grid.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; });
  grid.addEventListener('pointerup', function (e) {
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    go(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });
  kit.buttons(kit.$('controls'), [['New game', fresh, 'primary']]);
  kit.$('keep').addEventListener('click', function () { state.keepPlaying = true; render(); });
  kit.$('again').addEventListener('click', fresh);
  fresh();
})();
`;

export const game2048 = webApp({
  id: '2048',
  label: 'a 2048 game',
  summary: 'the sliding-tile puzzle 2048: merge equal tiles to reach 2048 and beyond',
  group: 'game',
  words: ['2048'],
  size: [560, 740],
  body: `      <div class="stage board">
        <div class="grid" id="grid" aria-label="2048 board"></div>
        <div class="overlay" id="msg" hidden><h3 id="title"></h3><p class="hint" id="sub"></p><div class="row"><button class="btn" id="keep" type="button">Keep going</button><button class="btn primary" id="again" type="button">New game</button></div></div>
      </div>
      <div class="row" id="controls"></div>
      <p class="hint">Arrow keys or WASD, or swipe. Equal tiles merge.</p>`,
  css: `
.board { padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; width: min(88vw, 440px); aspect-ratio: 1; }
.tile { display: flex; align-items: center; justify-content: center; border-radius: 10px; background: #1a1030; font-weight: 700; font-size: clamp(20px, 6vw, 38px); color: #fff; user-select: none; }
.tile.pop { animation: pop 0.16s ease-out; }
@keyframes pop { from { transform: scale(0.8); } to { transform: scale(1); } }
.t2 { background: #2d1b4e; } .t4 { background: #3b2166; } .t8 { background: #5b2c9a; } .t16 { background: #6d28d9; }
.t32 { background: #7c3aed; } .t64 { background: #8b5cf6; } .t128 { background: #a855f7; font-size: clamp(18px, 5vw, 32px); }
.t256 { background: #c026d3; font-size: clamp(18px, 5vw, 32px); } .t512 { background: #db2777; font-size: clamp(18px, 5vw, 32px); }
.t1024 { background: #f59e0b; color: #1c1002; font-size: clamp(15px, 4.2vw, 26px); } .t2048 { background: #fbbf24; color: #1c1002; font-size: clamp(15px, 4.2vw, 26px); box-shadow: 0 0 24px rgba(251, 191, 36, 0.6); }
.tbig { background: #fde68a; color: #1c1002; font-size: clamp(13px, 3.4vw, 22px); }
`,
  logic: G2048_LOGIC,
  ui: G2048_UI,
  test: G2048_TEST,
});

// ------------------------------------------------------------------------------------ MINESWEEPER

const MINES_LOGIC = String.raw`/*
 * {{NAME}} - the rules of Minesweeper. Pure logic; mines are placed on the first click, so the
 * first click is always safe (and, when the board has room, opens an area rather than a number).
 */
(function (root) {
  'use strict';

  function create(w, h, mines) {
    mines = Math.max(1, Math.min(mines, w * h - 1));
    var cells = [];
    for (var i = 0; i < w * h; i++) cells.push({ mine: false, adj: 0, open: false, flag: false });
    return { w: w, h: h, mines: mines, cells: cells, placed: false, status: 'ready', opened: 0, flags: 0 };
  }

  function neighbors(s, i) {
    var x = i % s.w, y = Math.floor(i / s.w), out = [];
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      var nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < s.w && ny < s.h) out.push(ny * s.w + nx);
    }
    return out;
  }

  function countAdjacent(s) {
    s.cells.forEach(function (c, i) {
      c.adj = neighbors(s, i).filter(function (n) { return s.cells[n].mine; }).length;
    });
  }

  // Put the mines down, keeping the first click and its neighbours clear if there is room for that.
  function place(s, safe, rng) {
    var avoid = {}; avoid[safe] = true;
    var roomy = s.w * s.h - 1 - neighbors(s, safe).length >= s.mines;
    if (roomy) neighbors(s, safe).forEach(function (n) { avoid[n] = true; });
    var pool = [];
    for (var i = 0; i < s.cells.length; i++) if (!avoid[i]) pool.push(i);
    for (var k = pool.length - 1; k > 0; k--) {       // Fisher-Yates, so every layout is equally likely
      var j = Math.floor(rng() * (k + 1));
      var t = pool[k]; pool[k] = pool[j]; pool[j] = t;
    }
    for (var m = 0; m < s.mines; m++) s.cells[pool[m]].mine = true;
    countAdjacent(s);
    s.placed = true; s.status = 'playing';
  }

  function reveal(s, i, rng) {
    if (s.status === 'won' || s.status === 'lost') return 0;
    var c = s.cells[i];
    if (!c || c.open || c.flag) return 0;
    if (!s.placed) place(s, i, rng || Math.random);
    if (c.mine) { c.open = true; s.status = 'lost'; s.cells.forEach(function (x) { if (x.mine) x.open = true; }); return 0; }
    var count = 0, stack = [i];
    while (stack.length) {                      // flood fill: a zero opens everything around it
      var k = stack.pop(), cell = s.cells[k];
      if (cell.open || cell.flag) continue;
      cell.open = true; count++; s.opened++;
      if (cell.adj === 0) neighbors(s, k).forEach(function (n) { if (!s.cells[n].open) stack.push(n); });
    }
    if (s.opened === s.w * s.h - s.mines) {
      s.status = 'won';
      s.cells.forEach(function (x) { if (x.mine && !x.flag) { x.flag = true; s.flags++; } });
    }
    return count;
  }

  function toggleFlag(s, i) {
    var c = s.cells[i];
    if (!c || c.open || s.status === 'won' || s.status === 'lost') return false;
    c.flag = !c.flag; s.flags += c.flag ? 1 : -1;
    return true;
  }

  // Click a number that already has its flags: open every other neighbour.
  function chord(s, i, rng) {
    var c = s.cells[i];
    if (!c || !c.open || c.adj === 0 || s.status !== 'playing') return 0;
    var around = neighbors(s, i);
    var flagged = around.filter(function (n) { return s.cells[n].flag; }).length;
    if (flagged !== c.adj) return 0;
    var total = 0;
    around.forEach(function (n) { if (!s.cells[n].flag && !s.cells[n].open) total += reveal(s, n, rng); });
    return total;
  }

  // For tests and for puzzles: build a board from rows like ['..*', '...'].
  function fromLayout(rows) {
    var s = create(rows[0].length, rows.length, 1);
    var count = 0;
    rows.forEach(function (row, y) { row.split('').forEach(function (ch, x) { if (ch === '*') { s.cells[y * s.w + x].mine = true; count++; } }); });
    s.mines = count; countAdjacent(s); s.placed = true; s.status = 'playing';
    return s;
  }

  var LEVELS = { beginner: [9, 9, 10], intermediate: [16, 16, 40], expert: [30, 16, 99] };
  var api = { create: create, reveal: reveal, toggleFlag: toggleFlag, chord: chord, neighbors: neighbors, fromLayout: fromLayout, LEVELS: LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Mines = api;
})(typeof window !== 'undefined' ? window : this);
`;

const MINES_TEST = String.raw`
const M = require('./logic.js');

test('every cell knows how many neighbours it has', () => {
  const s = M.create(5, 4, 3);
  assert.strictEqual(M.neighbors(s, 0).length, 3);
  assert.strictEqual(M.neighbors(s, 2).length, 5);
  assert.strictEqual(M.neighbors(s, 6).length, 8);
  assert.strictEqual(M.neighbors(s, 19).length, 3);
});

test('numbers count the mines around a cell', () => {
  const s = M.fromLayout(['*..', '...', '..*']);
  assert.strictEqual(s.cells[1].adj, 1);
  assert.strictEqual(s.cells[4].adj, 2);
  assert.strictEqual(s.cells[2].adj, 0);
});

test('the first click is always safe, with its neighbours clear too, for 300 different boards', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const s = M.create(9, 9, 10);
    const first = (seed * 7) % 81;
    M.reveal(s, first, seeded(seed));
    assert.strictEqual(s.status === 'lost', false, 'seed ' + seed);
    assert.strictEqual(s.cells.filter((c) => c.mine).length, 10);
    assert.strictEqual(s.cells[first].mine, false);
    assert.strictEqual(s.cells[first].adj, 0, 'the first click opens an area');
  }
});

test('a crowded board still keeps the first click itself safe', () => {
  const s = M.create(3, 3, 8);
  M.reveal(s, 4, seeded(1));
  assert.strictEqual(s.cells[4].mine, false);
  assert.strictEqual(s.cells.filter((c) => c.mine).length, 8);
});

test('opening a zero opens everything it touches, and stops at the numbers', () => {
  const s = M.fromLayout(['....', '....', '....', '*...']);
  M.reveal(s, 15, seeded(1));
  assert.strictEqual(s.cells[12].open, false);
  assert.strictEqual(s.cells[13].open, true);
  assert.strictEqual(s.cells[0].open, true);
  assert.strictEqual(s.status, 'won');
});

test('hitting a mine loses and shows every mine', () => {
  const s = M.fromLayout(['*.*', '...', '...']);
  M.reveal(s, 0, seeded(1));
  assert.strictEqual(s.status, 'lost');
  assert.strictEqual(s.cells[2].open, true);
});

test('a flagged cell cannot be opened by accident', () => {
  const s = M.fromLayout(['*..', '...', '...']);
  M.toggleFlag(s, 0);
  assert.strictEqual(M.reveal(s, 0, seeded(1)), 0);
  assert.strictEqual(s.status, 'playing');
  M.toggleFlag(s, 0);
  assert.strictEqual(s.flags, 0);
});

test('chording opens the rest around a satisfied number, and not before', () => {
  const s = M.fromLayout(['*..', '...', '...']);
  M.reveal(s, 4, seeded(1));
  assert.strictEqual(M.chord(s, 4, seeded(1)), 0);      // no flag yet
  M.toggleFlag(s, 0);
  assert.ok(M.chord(s, 4, seeded(1)) >= 0);
  assert.strictEqual(s.cells[8].open, true);
});

test('chording on a wrongly placed flag loses, as in the original', () => {
  const s = M.fromLayout(['*..', '...', '...']);
  M.reveal(s, 4, seeded(1));
  M.toggleFlag(s, 1);                                   // flag a safe cell next to the number
  M.chord(s, 4, seeded(1));
  assert.strictEqual(s.status, 'lost');
});

test('opening every safe cell wins', () => {
  const s = M.fromLayout(['*.', '..']);
  M.reveal(s, 1, seeded(1)); M.reveal(s, 2, seeded(1)); M.reveal(s, 3, seeded(1));
  assert.strictEqual(s.status, 'won');
});

test('nothing happens after the game is over', () => {
  const s = M.fromLayout(['*.', '..']);
  M.reveal(s, 0, seeded(1));
  assert.strictEqual(M.reveal(s, 3, seeded(1)), 0);
  assert.strictEqual(M.toggleFlag(s, 3), false);
});
done();
`;

const MINES_UI = String.raw`(function () {
  'use strict';
  var M = window.Mines, kit = window.kit;
  var level = kit.load('level', 'beginner'), state, seconds = 0, timer = 0;
  var board = kit.$('board');
  var COLORS = ['', '#60a5fa', '#34d399', '#f87171', '#a78bfa', '#fb923c', '#22d3ee', '#e5e7eb', '#9ca3af'];

  function build() {
    var d = M.LEVELS[level];
    state = M.create(d[0], d[1], d[2]);
    seconds = 0; clearInterval(timer); timer = 0;
    board.textContent = '';
    board.style.gridTemplateColumns = 'repeat(' + d[0] + ', 28px)';
    state.cells.forEach(function (c, i) {
      var b = kit.el('button', 'cell');
      b.type = 'button'; b.dataset.i = i;
      board.appendChild(b);
    });
    stats(); paint(); kit.$('face').textContent = ':)';
  }

  function stats() { kit.stats([['Mines', state.mines - state.flags], ['Time', seconds + 's'], ['Level', level]]); }

  function paint() {
    state.cells.forEach(function (c, i) {
      var b = board.children[i];
      b.className = 'cell' + (c.open ? ' open' : '') + (c.open && c.mine ? ' boom' : '');
      b.textContent = c.open ? (c.mine ? '*' : (c.adj ? String(c.adj) : '')) : (c.flag ? 'F' : '');
      b.style.color = c.open && c.adj ? COLORS[c.adj] : (c.flag ? '#fbbf24' : '');
    });
    stats();
    if (state.status === 'playing' && !timer) timer = setInterval(function () { seconds++; stats(); }, 1000);
    if (state.status === 'won' || state.status === 'lost') {
      clearInterval(timer); timer = 0;
      kit.$('face').textContent = state.status === 'won' ? 'B)' : 'X(';
      if (state.status === 'won') {
        var key = 'best-' + level, prev = kit.load(key, 0);
        if (!prev || seconds < prev) { kit.save(key, seconds); kit.toast('New best time: ' + seconds + 's'); }
        else kit.toast('Cleared in ' + seconds + 's (best ' + prev + 's)');
      } else kit.toast('Boom. Press the face to try again.');
    }
  }

  board.addEventListener('click', function (e) {
    var b = e.target.closest('.cell'); if (!b) return;
    var i = Number(b.dataset.i), c = state.cells[i];
    if (c.open) M.chord(state, i, Math.random); else M.reveal(state, i, Math.random);
    paint();
  });
  board.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var b = e.target.closest('.cell'); if (!b) return;
    M.toggleFlag(state, Number(b.dataset.i)); paint();
  });

  var sel = kit.$('level');
  Object.keys(M.LEVELS).forEach(function (k) {
    var o = kit.el('option', '', k.charAt(0).toUpperCase() + k.slice(1) + ' (' + M.LEVELS[k].join(' x ').replace(/ x (\d+)$/, ', $1 mines') + ')');
    o.value = k; sel.appendChild(o);
  });
  sel.value = level;
  sel.addEventListener('change', function () { level = sel.value; kit.save('level', level); build(); });
  kit.$('face').addEventListener('click', build);
  build();
})();
`;

export const minesweeperGame = webApp({
  id: 'minesweeper',
  label: 'a minesweeper game',
  summary: 'Minesweeper with three sizes, flags, chording and best times',
  group: 'game',
  words: ['minesweeper', 'mine sweeper'],
  size: [1020, 760],
  body: `      <div class="row"><select id="level" aria-label="Board size"></select><button class="btn primary" id="face" type="button" aria-label="New game">:)</button></div>
      <div class="mines" id="board" aria-label="Minefield"></div>
      <p class="hint">Click to open. Right-click to flag. Click an opened number to open the rest around it once its flags are down.</p>`,
  css: `
.mines { display: grid; gap: 2px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 100%; overflow: auto; }
.cell { width: 28px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: #1a1030; color: var(--text); font: 700 14px "Segoe UI", sans-serif; cursor: pointer; }
.cell:hover:not(.open) { background: #2a1850; }
.cell.open { background: #0d0818; cursor: default; border-color: #1d1233; }
.cell.boom { background: #7f1d1d; color: #fff; }
`,
  logic: MINES_LOGIC,
  ui: MINES_UI,
  test: MINES_TEST,
});
