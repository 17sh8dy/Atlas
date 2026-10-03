/**
 * The "clicker" project template: a complete, working incremental game that Atlas can write
 * into a folder with no model at all.
 *
 * Layout of the generated project (a plain web app wrapped in an Electron window, so it is a
 * real desktop app, and it still opens as a web page if Electron has not been installed yet):
 *
 *   index.html   the page — one stage on the left, one tabbed panel on the right
 *   style.css    black / purple theme
 *   game.js      the RULES. Pure logic, no DOM and no timers, so Node can test it (test.js does)
 *   ui.js        draws game.js and turns clicks into game.js calls
 *   main.js      the Electron window
 *   test.js      checks the maths: `npm test`
 *   Play.cmd     double-click to play
 *
 * ⚠️ These are `String.raw` templates holding JavaScript, CSS and HTML. Two rules keep them
 * honest: no backtick and no dollar-brace inside the generated code (build strings with `+`),
 * because either would end or interpolate the TypeScript literal around it. `clicker-game.test.ts`
 * writes the project to disk, syntax-checks every .js file and runs the generated test.js, so a
 * slip fails here rather than in someone's folder.
 */

import type { TemplateFile, TemplateOptions } from './types';

const GAME_JS = String.raw`/*
 * {{NAME}} - the rules of the game.
 *
 * Pure logic: no DOM, no timers, no randomness it does not get handed. ui.js draws this and
 * test.js checks it, which is why it can be trusted to do the same maths in both.
 *
 * The maths in one place:
 *   cost of the next unit      base * 1.15 ^ owned
 *   cost of n units            base * 1.15 ^ owned * (1.15 ^ n - 1) / 0.15      (a geometric sum)
 *   most units a budget buys   floor( ln(1 + budget * 0.15 / firstCost) / ln(1.15) )
 *   milestones                 every owned-count in MILESTONES doubles that generator
 *   shards from an ascension   floor( cbrt( essence earned this run / 1e9 ) )
 *   each shard                 +2% to everything, multiplying with the rest
 */
(function (root) {
  'use strict';

  var SAVE_KEY = '{{ID}}.save.v1';
  var GROWTH = 1.15;
  var MILESTONES = [10, 25, 50, 100, 150, 200, 250, 300, 350, 400];
  var SHARD_BOOST = 0.02;
  var ACHIEVEMENT_BOOST = 0.01;
  var SURGE_MULT = 7;
  var SURGE_SECONDS = 30;
  var ORB_LIFETIME_MS = 14000;
  var OFFLINE_CAP_SECONDS = 8 * 3600;
  var ASCEND_DIVISOR = 1e9;

  // 'payback' is the design number: the seconds one unit takes to earn back its own first price.
  // Production per second is base / payback, so every tier is a comparable deal when you buy it,
  // and the climb is steep without being a wall (a steady player passes 1 billion in about an
  // hour and 1 trillion in under two).
  var GENERATORS = [
    { id: 'spark',    name: 'Spark',         base: 15,      payback: 200, blurb: 'A flicker that refuses to go out.' },
    { id: 'wisp',     name: 'Wisp',          base: 100,     payback: 170, blurb: 'Drifts in from the dark and brings a little with it.' },
    { id: 'ember',    name: 'Ember Well',    base: 1100,    payback: 150, blurb: 'A pit that never runs dry.' },
    { id: 'rift',     name: 'Rift',          base: 12000,   payback: 140, blurb: 'A crack in the night that leaks essence.' },
    { id: 'beacon',   name: 'Beacon',        base: 130000,  payback: 135, blurb: 'Calls essence home from very far away.' },
    { id: 'forge',    name: 'Nebula Forge',  base: 1.4e6,   payback: 135, blurb: 'Hammers starlight into something useful.' },
    { id: 'sing',     name: 'Singularity',   base: 2e7,     payback: 140, blurb: 'Everything falls toward it. Some of it is yours.' },
    { id: 'horizon',  name: 'Event Horizon', base: 3.3e8,   payback: 145, blurb: 'The edge of the place where rules stop.' },
    { id: 'loom',     name: 'Cosmic Loom',   base: 5.1e9,   payback: 150, blurb: 'Weaves the threads between stars into income.' },
    { id: 'engine',   name: 'Void Engine',   base: 7.5e10,  payback: 160, blurb: 'The last machine. It has been running forever.' }
  ];
  GENERATORS.forEach(function (g) { g.rate = g.base / g.payback; });

  /* ---------- upgrades ---------- */

  var UPGRADES = [];
  function addUpgrade(u) { UPGRADES.push(u); }

  // Click power.
  [
    ['hand1', 'Steady Hand',      100,    2],
    ['hand2', 'Firm Grip',        5e3,    2],
    ['hand3', 'Iron Fingers',     5e5,    2],
    ['hand4', 'Void Touch',       5e7,    3],
    ['hand5', 'Starbreaker',      5e9,    3],
    ['hand6', 'Hand of Eternity', 5e12,   5]
  ].forEach(function (r) {
    addUpgrade({ id: r[0], name: r[1], cost: r[2], kind: 'click', mult: r[3], desc: 'Clicking is x' + r[3] + ' stronger.' });
  });

  // Clicks that also borrow from the whole machine.
  [
    ['reson1', 'Resonance', 1e4,  0.01],
    ['reson2', 'Harmonics', 1e8,  0.02],
    ['reson3', 'Overtone',  1e13, 0.05]
  ].forEach(function (r) {
    addUpgrade({ id: r[0], name: r[1], cost: r[2], kind: 'clickPct', pct: r[3], desc: 'Each click also gives ' + (r[3] * 100) + '% of your essence per second.' });
  });

  // Three tiers for every generator.
  var TIERS = [
    { tag: 'I',   costX: 10,   own: 1,  mult: 2 },
    { tag: 'II',  costX: 1000, own: 15, mult: 2 },
    { tag: 'III', costX: 1e5,  own: 60, mult: 3 }
  ];
  GENERATORS.forEach(function (g, i) {
    TIERS.forEach(function (t) {
      addUpgrade({
        id: 'gen' + i + t.tag, name: g.name + ' Overclock ' + t.tag, cost: g.base * t.costX,
        kind: 'gen', gen: i, mult: t.mult, needOwned: t.own,
        desc: g.name + ' makes x' + t.mult + ' as much. Needs ' + t.own + ' owned.'
      });
    });
  });

  // Everything at once.
  [
    ['glob1', 'Void Lens',      5e3,  1.25],
    ['glob2', 'Prism',          5e5,  1.25],
    ['glob3', 'Aperture',       5e8,  1.5],
    ['glob4', 'Cosmic Web',     5e11, 1.5],
    ['glob5', 'Heart of Night', 5e15, 2],
    ['glob6', 'Last Light',     5e20, 2]
  ].forEach(function (r) {
    addUpgrade({ id: r[0], name: r[1], cost: r[2], kind: 'global', mult: r[3], desc: 'All essence production x' + r[3] + '.' });
  });

  // One generator feeding another: +X% per unit owned of the source.
  [
    ['syn1', 'Entanglement', 2.5e4,  0, 1, 0.01],
    ['syn2', 'Cascade',      2.5e7,  1, 3, 0.005],
    ['syn3', 'Convergence',  2.5e10, 3, 6, 0.004],
    ['syn4', 'Collapse',     2.5e14, 6, 9, 0.003]
  ].forEach(function (r) {
    addUpgrade({
      id: r[0], name: r[1], cost: r[2], kind: 'synergy', from: r[3], gen: r[4], per: r[5],
      desc: GENERATORS[r[4]].name + ' gains +' + (r[5] * 100) + '% for every ' + GENERATORS[r[3]].name + ' you own.'
    });
  });

  UPGRADES.sort(function (a, b) { return a.cost - b.cost; });
  var UPGRADE_BY_ID = {};
  UPGRADES.forEach(function (u) { UPGRADE_BY_ID[u.id] = u; });

  /* ---------- permanent (ascension) upgrades ---------- */

  var SHARD_UPGRADES = [
    { id: 'memory',   name: 'Ember Memory',     cost: 1, desc: 'Every run begins with 1,000 essence.' },
    { id: 'echo',     name: 'Echoing Hand',     cost: 2, desc: 'Clicking is x2 stronger, forever.' },
    { id: 'slumber',  name: 'Slumbering Power', cost: 3, desc: 'Offline progress rises from 25% to 60%.' },
    { id: 'bargain',  name: 'Void Bargain',     cost: 5, desc: 'Every generator costs 5% less.' },
    { id: 'caller',   name: 'Surge Caller',     cost: 8, desc: 'Rift Surges arrive twice as often and last 50% longer.' }
  ];

  /* ---------- achievements ---------- */

  function ownedTotal(s) { var t = 0; for (var i = 0; i < s.owned.length; i++) t += s.owned[i]; return t; }
  function upgradeCount(s) { return Object.keys(s.upgrades).length; }

  var ACHIEVEMENTS = [
    { id: 'a1',  name: 'First Touch',      desc: 'Click once.',                        test: function (s) { return s.clicks >= 1; } },
    { id: 'a2',  name: 'Restless Hands',   desc: 'Click 100 times.',                   test: function (s) { return s.clicks >= 100; } },
    { id: 'a3',  name: 'Carpal Tunnel',    desc: 'Click 5,000 times.',                 test: function (s) { return s.clicks >= 5000; } },
    { id: 'a4',  name: 'Small Fire',       desc: 'Earn 1,000 essence in total.',       test: function (s) { return s.all >= 1e3; } },
    { id: 'a5',  name: 'Bonfire',          desc: 'Earn 1 million in total.',           test: function (s) { return s.all >= 1e6; } },
    { id: 'a6',  name: 'Starlight',        desc: 'Earn 1 billion in total.',           test: function (s) { return s.all >= 1e9; } },
    { id: 'a7',  name: 'Galaxy Brain',     desc: 'Earn 1 trillion in total.',          test: function (s) { return s.all >= 1e12; } },
    { id: 'a8',  name: 'Beyond Counting',  desc: 'Earn 1 quadrillion in total.',       test: function (s) { return s.all >= 1e15; } },
    { id: 'a9',  name: 'Full Set',         desc: 'Own at least one of every generator.', test: function (s) { return s.owned.every(function (n) { return n > 0; }); } },
    { id: 'a10', name: 'Crowd',            desc: 'Own 100 generators.',                test: function (s) { return ownedTotal(s) >= 100; } },
    { id: 'a11', name: 'Tinkerer',         desc: 'Buy 10 upgrades.',                   test: function (s) { return upgradeCount(s) >= 10; } },
    { id: 'a12', name: 'Engineer',         desc: 'Buy 30 upgrades.',                   test: function (s) { return upgradeCount(s) >= 30; } },
    { id: 'a13', name: 'Surfer',           desc: 'Catch a Rift Surge.',                test: function (s) { return s.surges >= 1; } },
    { id: 'a14', name: 'Reborn',           desc: 'Ascend for the first time.',         test: function (s) { return s.ascensions >= 1; } },
    { id: 'a15', name: 'Cycle',            desc: 'Ascend five times.',                 test: function (s) { return s.ascensions >= 5; } }
  ];

  /* ---------- numbers ---------- */

  var SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

  function trimZeros(text) {
    return text.indexOf('.') >= 0 ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  }

  // 12,345 -> "12.35K"; 4.2e12 -> "4.2T"; past Dc it falls back to 1.23e45.
  function fmt(n) {
    if (n !== n) return '0';
    if (n === Infinity) return 'inf';
    if (n < 0) return '-' + fmt(-n);
    if (n < 1000) {
      if (n < 10) return trimZeros(n.toFixed(2));
      if (n < 100) return trimZeros(n.toFixed(1));
      return String(Math.floor(n));
    }
    var tier = Math.floor(Math.log(n) / Math.LN10 / 3);
    var text = (n / Math.pow(10, tier * 3)).toFixed(2);
    if (parseFloat(text) >= 1000) { tier += 1; text = (n / Math.pow(10, tier * 3)).toFixed(2); }
    if (tier >= SUFFIX.length) return n.toExponential(2).replace('e+', 'e');
    return trimZeros(text) + SUFFIX[tier];
  }

  // Every digit, for the Stats page: 1234567 -> "1,234,567".
  function fmtFull(n) {
    if (n !== n || n === Infinity) return fmt(n);
    if (n >= 1e21) return n.toExponential(3).replace('e+', 'e');
    return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtTime(seconds) {
    seconds = Math.floor(seconds);
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  /* ---------- cost maths ---------- */

  // Total price of buying n more of generator i when you already own 'owned'.
  function costOf(i, owned, n, discount) {
    if (n <= 0) return 0;
    var d = discount === undefined ? 1 : discount;
    var first = GENERATORS[i].base * Math.pow(GROWTH, owned);
    if (n === 1) return first * d;   // exact: the closed form below loses a few bits at n = 1
    return first * (Math.pow(GROWTH, n) - 1) / (GROWTH - 1) * d;
  }

  // The most you can afford, found with a logarithm and then nudged to dodge rounding.
  function maxBuyable(i, owned, budget, discount) {
    var d = discount === undefined ? 1 : discount;
    var first = GENERATORS[i].base * Math.pow(GROWTH, owned) * d;
    if (!(budget >= first)) return 0;
    var n = Math.floor(Math.log(1 + budget * (GROWTH - 1) / first) / Math.log(GROWTH));
    if (!isFinite(n)) return 0;
    while (n > 0 && costOf(i, owned, n, d) > budget) n--;
    while (costOf(i, owned, n + 1, d) <= budget) n++;
    return n;
  }

  function milestonesReached(owned) {
    var c = 0;
    for (var i = 0; i < MILESTONES.length; i++) if (owned >= MILESTONES[i]) c++;
    return c;
  }

  /* ---------- state ---------- */

  function freshState(now) {
    return {
      v: 1,
      essence: 0,          // what you can spend
      run: 0,              // earned since the last ascension (drives shards)
      all: 0,              // earned, ever
      clicks: 0,
      owned: GENERATORS.map(function () { return 0; }),
      upgrades: {},
      shards: 0,           // unspent
      shardsTotal: 0,      // ever earned: this is what boosts production
      shardUpgrades: {},
      ascensions: 0,
      achievements: {},
      surges: 0,
      buffUntil: 0,
      orbUntil: 0,
      nextOrbAt: (now || 0) + 150000,   // the first Surge waits until there is something to multiply
      playSeconds: 0,
      bestEps: 0,
      savedAt: now || 0
    };
  }

  function normalize(raw, now) {
    var base = freshState(now);
    if (!raw || typeof raw !== 'object') return base;
    Object.keys(base).forEach(function (k) {
      if (raw[k] === undefined) return;
      if (typeof base[k] === typeof raw[k]) base[k] = raw[k];
    });
    base.owned = GENERATORS.map(function (_, i) {
      var n = raw.owned && raw.owned[i];
      return typeof n === 'number' && n >= 0 ? Math.floor(n) : 0;
    });
    ['upgrades', 'shardUpgrades', 'achievements'].forEach(function (k) {
      var out = {};
      if (raw[k] && typeof raw[k] === 'object') Object.keys(raw[k]).forEach(function (id) { if (raw[k][id]) out[id] = true; });
      base[k] = out;
    });
    ['essence', 'run', 'all', 'shards', 'shardsTotal'].forEach(function (k) {
      if (!(base[k] >= 0) || !isFinite(base[k])) base[k] = 0;
    });
    return base;
  }

  /* ---------- the game ---------- */

  function createGame(options) {
    options = options || {};
    var now0 = options.now || 0;
    var s = options.state ? normalize(options.state, now0) : freshState(now0);
    var cache = null;

    function dirty() { cache = null; }

    function discount() { return s.shardUpgrades.bargain ? 0.95 : 1; }

    function achievementCount() { return Object.keys(s.achievements).length; }

    function globalMult() {
      var m = (1 + SHARD_BOOST * s.shardsTotal) * (1 + ACHIEVEMENT_BOOST * achievementCount());
      UPGRADES.forEach(function (u) { if (u.kind === 'global' && s.upgrades[u.id]) m *= u.mult; });
      return m;
    }

    function clickBase() {
      var m = 1;
      UPGRADES.forEach(function (u) { if (u.kind === 'click' && s.upgrades[u.id]) m *= u.mult; });
      if (s.shardUpgrades.echo) m *= 2;
      return m;
    }

    function clickPct() {
      var p = 0;
      UPGRADES.forEach(function (u) { if (u.kind === 'clickPct' && s.upgrades[u.id]) p += u.pct; });
      return p;
    }

    function genMult(i) {
      var m = Math.pow(2, milestonesReached(s.owned[i]));
      UPGRADES.forEach(function (u) {
        if (!s.upgrades[u.id]) return;
        if (u.kind === 'gen' && u.gen === i) m *= u.mult;
        if (u.kind === 'synergy' && u.gen === i) m *= 1 + u.per * s.owned[u.from];
      });
      return m;
    }

    // Everything that depends only on what you own, worked out once per change.
    function derived() {
      if (cache) return cache;
      var g = globalMult();
      var per = GENERATORS.map(function (gen, i) { return gen.rate * genMult(i) * g; });
      var eps = 0;
      per.forEach(function (rate, i) { eps += rate * s.owned[i]; });
      cache = { global: g, perUnit: per, eps: eps, clickBase: clickBase() * g, clickPct: clickPct() };
      return cache;
    }

    function surgeActive(now) { return now < s.buffUntil; }
    function surgeFactor(now) { return surgeActive(now) ? SURGE_MULT : 1; }

    function eps(now) { return derived().eps * surgeFactor(now); }
    function clickValue(now) {
      var d = derived();
      return (d.clickBase + d.clickPct * d.eps) * surgeFactor(now);
    }

    function checkAchievements() {
      var fresh = [];
      ACHIEVEMENTS.forEach(function (a) {
        if (!s.achievements[a.id] && a.test(s)) { s.achievements[a.id] = true; fresh.push(a); }
      });
      if (fresh.length) dirty();
      return fresh;
    }

    function earn(amount) {
      s.essence += amount; s.run += amount; s.all += amount;
    }

    var api = {
      state: s,
      data: { GENERATORS: GENERATORS, UPGRADES: UPGRADES, SHARD_UPGRADES: SHARD_UPGRADES, ACHIEVEMENTS: ACHIEVEMENTS, MILESTONES: MILESTONES, SURGE_MULT: SURGE_MULT, SURGE_SECONDS: SURGE_SECONDS, ORB_LIFETIME_MS: ORB_LIFETIME_MS },

      eps: eps,
      clickValue: clickValue,
      globalMult: function () { return derived().global; },
      perUnit: function (i) { return derived().perUnit[i]; },
      surgeActive: surgeActive,
      achievementCount: achievementCount,
      // Forget cached multipliers. The game does this itself on every purchase; it is here for
      // code (and tests) that change the state directly.
      refresh: dirty,
      discount: discount,

      click: function (now) {
        var gain = clickValue(now);
        s.clicks += 1;
        earn(gain);
        return { gain: gain, achievements: checkAchievements() };
      },

      tick: function (dt, now) {
        if (!(dt > 0)) return [];
        var rate = eps(now);
        earn(rate * dt);
        s.playSeconds += dt;
        if (rate > s.bestEps) s.bestEps = rate;
        return checkAchievements();
      },

      price: function (i, n) { return costOf(i, s.owned[i], n, discount()); },
      affordable: function (i) { return maxBuyable(i, s.owned[i], s.essence, discount()); },

      // n is a number or 'max'. Returns how many were bought (0 if it could not).
      buy: function (i, n) {
        var count = n === 'max' ? maxBuyable(i, s.owned[i], s.essence, discount()) : n;
        if (!(count >= 1)) return 0;
        var cost = costOf(i, s.owned[i], count, discount());
        if (cost > s.essence) return 0;
        s.essence -= cost;
        s.owned[i] += count;
        dirty();
        checkAchievements();
        return count;
      },

      upgradeAvailable: function (u) {
        if (s.upgrades[u.id]) return false;
        if (u.kind === 'gen' && s.owned[u.gen] < u.needOwned) return false;
        if (u.kind === 'synergy' && s.owned[u.from] < 1) return false;
        return s.run >= u.cost * 0.2 || s.essence >= u.cost * 0.2;
      },
      buyUpgrade: function (id) {
        var u = UPGRADE_BY_ID[id];
        if (!u || s.upgrades[u.id] || s.essence < u.cost) return false;
        if (!api.upgradeAvailable(u)) return false;
        s.essence -= u.cost;
        s.upgrades[u.id] = true;
        dirty();
        checkAchievements();
        return true;
      },

      pendingShards: function () { return Math.floor(Math.cbrt(s.run / ASCEND_DIVISOR)); },
      ascend: function (now) {
        var gained = api.pendingShards();
        if (gained < 1) return 0;
        s.shards += gained;
        s.shardsTotal += gained;
        s.ascensions += 1;
        s.essence = s.shardUpgrades.memory ? 1000 : 0;
        s.run = 0;
        s.owned = GENERATORS.map(function () { return 0; });
        s.upgrades = {};
        s.buffUntil = 0;
        s.orbUntil = 0;
        s.nextOrbAt = now + 45000;
        dirty();
        checkAchievements();
        return gained;
      },
      buyShardUpgrade: function (id) {
        var u = SHARD_UPGRADES.filter(function (x) { return x.id === id; })[0];
        if (!u || s.shardUpgrades[id] || s.shards < u.cost) return false;
        s.shards -= u.cost;
        s.shardUpgrades[id] = true;
        dirty();
        return true;
      },

      // Rift Surges: an orb appears now and then; catching it multiplies everything for a while.
      orbVisible: function (now) { return now < s.orbUntil; },
      updateOrb: function (now, random) {
        if (s.orbUntil && now >= s.orbUntil) s.orbUntil = 0;
        if (!s.orbUntil && now >= s.nextOrbAt) {
          var fast = s.shardUpgrades.caller ? 2 : 1;
          s.orbUntil = now + ORB_LIFETIME_MS * (s.shardUpgrades.caller ? 1.5 : 1);
          s.nextOrbAt = s.orbUntil + (60000 + 90000 * random) / fast;
          return true;
        }
        return false;
      },
      catchOrb: function (now) {
        if (!(now < s.orbUntil)) return false;
        s.orbUntil = 0;
        s.buffUntil = now + SURGE_SECONDS * 1000 * (s.shardUpgrades.caller ? 1.5 : 1);
        s.surges += 1;
        checkAchievements();
        return true;
      },

      // Pays out time spent away, at a reduced rate. Returns null when it was too short to matter.
      applyOffline: function (now) {
        var away = Math.min(Math.max(0, (now - s.savedAt) / 1000), OFFLINE_CAP_SECONDS);
        if (away < 60) return null;
        var efficiency = s.shardUpgrades.slumber ? 0.6 : 0.25;
        var gain = derived().eps * away * efficiency;
        earn(gain);
        checkAchievements();
        return { seconds: away, gain: gain, efficiency: efficiency };
      },

      serialize: function (now) { s.savedAt = now; return JSON.stringify(s); },
      reset: function (now) {
        var f = freshState(now);
        Object.keys(s).forEach(function (k) { delete s[k]; });
        Object.keys(f).forEach(function (k) { s[k] = f[k]; });
        dirty();
      }
    };

    dirty();
    checkAchievements();
    return api;
  }

  var exported = {
    SAVE_KEY: SAVE_KEY, GROWTH: GROWTH, createGame: createGame, normalize: normalize, freshState: freshState,
    costOf: costOf, maxBuyable: maxBuyable, milestonesReached: milestonesReached,
    fmt: fmt, fmtFull: fmtFull, fmtTime: fmtTime,
    GENERATORS: GENERATORS, UPGRADES: UPGRADES, SHARD_UPGRADES: SHARD_UPGRADES, ACHIEVEMENTS: ACHIEVEMENTS, MILESTONES: MILESTONES
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else root.Game = exported;
})(typeof window !== 'undefined' ? window : this);
`;

const UI_JS = String.raw`/* {{NAME}} - draws the game and turns clicks into game.js calls. */
(function () {
  'use strict';

  var G = window.Game;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = G.fmt;

  var game;
  var buyAmount = 1;        // 1, 10, 100 or 'max'
  var tab = 'generators';
  var lastFrame = Date.now();
  var lastSave = Date.now();
  var toastTimer = 0;
  var resetArmedUntil = 0;
  var floaters = 0;

  /* ---------- save / load ---------- */

  function readSave() {
    try { return localStorage.getItem(G.SAVE_KEY); } catch (e) { return null; }
  }
  function writeSave() {
    try { localStorage.setItem(G.SAVE_KEY, game.serialize(Date.now())); lastSave = Date.now(); } catch (e) { /* storage can be unavailable */ }
  }
  function encode(text) { return btoa(unescape(encodeURIComponent(text))); }
  function decode(text) { return decodeURIComponent(escape(atob(text.trim()))); }

  function load() {
    var saved = readSave();
    var state = null;
    if (saved) { try { state = JSON.parse(saved); } catch (e) { state = null; } }
    game = G.createGame({ state: state, now: Date.now() });
    var away = state ? game.applyOffline(Date.now()) : null;
    if (away) toast('Welcome back. ' + G.fmtTime(away.seconds) + ' away earned ' + fmt(away.gain) + ' essence (' + Math.round(away.efficiency * 100) + '%).');
  }

  /* ---------- small helpers ---------- */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4200);
  }

  function floatText(text, x, y, cls) {
    if (floaters > 24) return;
    floaters++;
    var f = el('span', 'float ' + (cls || ''), text);
    f.style.left = x + 'px';
    f.style.top = y + 'px';
    $('stage').appendChild(f);
    setTimeout(function () { f.remove(); floaters--; }, 950);
  }

  function flash(node) {
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
  }

  function announce(list) {
    list.forEach(function (a) { toast('Achievement: ' + a.name + ' - ' + a.desc); });
  }

  /* ---------- building the panels once ---------- */

  var genRows = [];
  var upgradeList, shardList, achList;

  function buildGenerators() {
    var host = $('generators');
    G.GENERATORS.forEach(function (g, i) {
      var row = el('button', 'row gen');
      row.type = 'button';
      var left = el('div', 'row-main');
      var name = el('div', 'row-name');
      var title = el('span', 'name', g.name);
      var count = el('span', 'count', '0');
      name.appendChild(title); name.appendChild(count);
      var blurb = el('div', 'row-sub', g.blurb);
      var rate = el('div', 'row-rate', '');
      left.appendChild(name); left.appendChild(blurb); left.appendChild(rate);
      var cost = el('div', 'row-cost', '');
      row.appendChild(left); row.appendChild(cost);
      row.addEventListener('click', function () {
        if (game.buy(i, buyAmount)) flash(row);
      });
      host.appendChild(row);
      genRows.push({ row: row, count: count, blurb: blurb, rate: rate, cost: cost, title: title });
    });
  }

  function amountLabel(i) {
    var n = buyAmount === 'max' ? game.affordable(i) : buyAmount;
    return n < 1 ? 1 : n;
  }

  function updateGenerators() {
    var s = game.state;
    G.GENERATORS.forEach(function (g, i) {
      var r = genRows[i];
      var seen = i === 0 || s.owned[i] > 0 || s.owned[i - 1] > 0 || s.all >= g.base * 0.5;
      r.row.classList.toggle('locked', !seen);
      if (!seen) { r.title.textContent = '???'; r.blurb.textContent = 'Keep going.'; r.rate.textContent = ''; r.cost.textContent = ''; r.count.textContent = ''; r.row.disabled = true; return; }
      var n = amountLabel(i);
      var price = game.price(i, n);
      r.title.textContent = g.name;
      r.blurb.textContent = g.blurb;
      r.count.textContent = s.owned[i];
      var unit = game.perUnit(i);
      var next = G.MILESTONES.filter(function (m) { return m > s.owned[i]; })[0];
      r.rate.textContent = fmt(unit) + '/s each' + (s.owned[i] ? ' - ' + fmt(unit * s.owned[i]) + '/s total' : '') + (next ? ' - x2 at ' + next : '');
      r.cost.textContent = 'x' + n + '  ' + fmt(price);
      var can = s.essence >= price;
      r.row.disabled = !can;
      r.row.classList.toggle('can', can);
    });
  }

  function buildUpgrades() { upgradeList = $('upgrades-list'); }
  function updateUpgrades() {
    var s = game.state;
    var shown = G.UPGRADES.filter(function (u) { return game.upgradeAvailable(u); }).slice(0, 12);
    var key = shown.map(function (u) { return u.id; }).join(',');
    if (upgradeList.dataset.key !== key) {
      upgradeList.dataset.key = key;
      upgradeList.textContent = '';
      if (!shown.length) upgradeList.appendChild(el('p', 'empty', 'Nothing new yet. Buy more generators and earn more essence.'));
      shown.forEach(function (u) {
        var b = el('button', 'row up');
        b.type = 'button';
        b.dataset.id = u.id;
        var main = el('div', 'row-main');
        main.appendChild(el('div', 'row-name', u.name));
        main.appendChild(el('div', 'row-sub', u.desc));
        b.appendChild(main);
        b.appendChild(el('div', 'row-cost', fmt(u.cost)));
        b.addEventListener('click', function () { if (game.buyUpgrade(u.id)) toast('Bought ' + u.name + '.'); });
        upgradeList.appendChild(b);
      });
    }
    Array.prototype.forEach.call(upgradeList.children, function (b) {
      if (!b.dataset || !b.dataset.id) return;
      var can = s.essence >= G.UPGRADES.filter(function (u) { return u.id === b.dataset.id; })[0].cost;
      b.disabled = !can;
      b.classList.toggle('can', can);
    });
    $('up-count').textContent = Object.keys(s.upgrades).length + ' / ' + G.UPGRADES.length + ' bought';
  }

  function buildShards() {
    shardList = $('shard-list');
    G.SHARD_UPGRADES.forEach(function (u) {
      var b = el('button', 'row up');
      b.type = 'button';
      b.dataset.id = u.id;
      var main = el('div', 'row-main');
      main.appendChild(el('div', 'row-name', u.name));
      main.appendChild(el('div', 'row-sub', u.desc));
      b.appendChild(main);
      b.appendChild(el('div', 'row-cost', u.cost + (u.cost === 1 ? ' shard' : ' shards')));
      b.addEventListener('click', function () { game.buyShardUpgrade(u.id); });
      shardList.appendChild(b);
    });
    $('ascend').addEventListener('click', function () {
      var gained = game.ascend(Date.now());
      if (gained) { toast('You ascended and gained ' + gained + ' shard' + (gained === 1 ? '' : 's') + '. Everything restarts, but you are stronger.'); writeSave(); }
    });
  }
  function updateShards() {
    var s = game.state;
    var pending = game.pendingShards();
    $('shards-owned').textContent = s.shards + ' to spend (' + s.shardsTotal + ' earned, +' + Math.round(s.shardsTotal * 2) + '% to everything)';
    $('ascend').disabled = pending < 1;
    $('ascend').textContent = pending < 1 ? 'Earn 1 billion essence this run to ascend' : 'Ascend for ' + pending + ' shard' + (pending === 1 ? '' : 's');
    $('ascend-math').textContent = 'shards = floor( cbrt( ' + fmt(s.run) + ' / 1B ) ) = ' + pending + '. Next shard at ' + fmt(Math.pow(pending + 1, 3) * 1e9) + ' this run.';
    Array.prototype.forEach.call(shardList.children, function (b) {
      var u = G.SHARD_UPGRADES.filter(function (x) { return x.id === b.dataset.id; })[0];
      var owned = !!s.shardUpgrades[u.id];
      b.disabled = owned || s.shards < u.cost;
      b.classList.toggle('owned', owned);
      b.lastChild.textContent = owned ? 'owned' : u.cost + (u.cost === 1 ? ' shard' : ' shards');
    });
  }

  function buildStats() {
    achList = $('ach-list');
    G.ACHIEVEMENTS.forEach(function (a) {
      var li = el('li', 'ach');
      li.dataset.id = a.id;
      li.appendChild(el('strong', '', a.name));
      li.appendChild(el('span', '', a.desc));
      achList.appendChild(li);
    });
    $('export').addEventListener('click', function () {
      var box = $('save-box');
      box.value = encode(game.serialize(Date.now()));
      box.select();
      toast('Save copied into the box. Keep it somewhere safe.');
    });
    $('import').addEventListener('click', function () {
      var box = $('save-box');
      try {
        var state = JSON.parse(decode(box.value));
        game = G.createGame({ state: state, now: Date.now() });
        writeSave();
        toast('Save loaded.');
      } catch (e) { toast('That does not look like a save.'); }
    });
    $('reset').addEventListener('click', function () {
      var t = Date.now();
      if (t > resetArmedUntil) { resetArmedUntil = t + 4000; $('reset').textContent = 'Click again to erase everything'; setTimeout(function () { $('reset').textContent = 'Erase save'; }, 4000); return; }
      game.reset(t); writeSave(); resetArmedUntil = 0; $('reset').textContent = 'Erase save'; toast('Fresh start.');
    });
  }

  function updateStats() {
    var s = game.state;
    var d = game.data;
    var rows = [
      ['Essence per second', fmt(game.eps(Date.now()))],
      ['Per click', fmt(game.clickValue(Date.now()))],
      ['Global multiplier', 'x' + fmt(game.globalMult())],
      ['Earned this run', G.fmtFull(s.run)],
      ['Earned ever', G.fmtFull(s.all)],
      ['Clicks', G.fmtFull(s.clicks)],
      ['Generators owned', G.fmtFull(s.owned.reduce(function (a, b) { return a + b; }, 0))],
      ['Best per second', fmt(s.bestEps)],
      ['Ascensions', String(s.ascensions)],
      ['Rift Surges caught', String(s.surges)],
      ['Time played', G.fmtTime(s.playSeconds)]
    ];
    var host = $('stat-rows');
    if (host.children.length !== rows.length) {
      host.textContent = '';
      rows.forEach(function () { var r = el('div', 'stat'); r.appendChild(el('span', 'k')); r.appendChild(el('span', 'v')); host.appendChild(r); });
    }
    rows.forEach(function (r, i) { host.children[i].firstChild.textContent = r[0]; host.children[i].lastChild.textContent = r[1]; });
    $('ach-count').textContent = game.achievementCount() + ' / ' + d.ACHIEVEMENTS.length + ' (each is +1% to everything)';
    Array.prototype.forEach.call(achList.children, function (li) { li.classList.toggle('got', !!s.achievements[li.dataset.id]); });
  }

  /* ---------- the stage ---------- */

  function setupStage() {
    var orb = $('orb');
    orb.addEventListener('pointerdown', function (e) {
      var out = game.click(Date.now());
      var rect = $('stage').getBoundingClientRect();
      var x = e.clientX ? e.clientX - rect.left : rect.width / 2;
      var y = e.clientY ? e.clientY - rect.top : rect.height / 2;
      floatText('+' + fmt(out.gain), x, y);
      announce(out.achievements);
      orb.classList.remove('pulse'); void orb.offsetWidth; orb.classList.add('pulse');
    });
    // Keyboard: Space / Enter on the focused orb gives a click with no pointer position.
    orb.addEventListener('keydown', function (e) {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      var out = game.click(Date.now());
      floatText('+' + fmt(out.gain), $('stage').clientWidth / 2, $('stage').clientHeight / 2);
      announce(out.achievements);
    });
    $('surge').addEventListener('click', function () {
      if (game.catchOrb(Date.now())) toast('Rift Surge! Everything is x' + game.data.SURGE_MULT + ' for ' + game.data.SURGE_SECONDS + ' seconds.');
    });
    document.querySelectorAll('[data-amount]').forEach(function (b) {
      b.addEventListener('click', function () {
        buyAmount = b.dataset.amount === 'max' ? 'max' : Number(b.dataset.amount);
        document.querySelectorAll('[data-amount]').forEach(function (o) { o.classList.toggle('on', o === b); });
      });
    });
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { tab = b.dataset.tab; showTab(); });
    });
  }

  function showTab() {
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
    document.querySelectorAll('.page').forEach(function (p) { p.hidden = p.id !== 'page-' + tab; });
  }

  function updateStage(now) {
    var s = game.state;
    $('essence').textContent = fmt(s.essence);
    $('eps').textContent = fmt(game.eps(now)) + ' essence per second';
    $('click-value').textContent = '+' + fmt(game.clickValue(now)) + ' per click';
    $('stage').classList.toggle('surging', game.surgeActive(now));
    var left = Math.max(0, Math.ceil((s.buffUntil - now) / 1000));
    $('surge-banner').textContent = game.surgeActive(now) ? 'Rift Surge x' + game.data.SURGE_MULT + ' - ' + left + 's' : '';
    var orbShown = game.orbVisible(now);
    var surge = $('surge');
    if (orbShown && surge.hidden) {
      surge.style.left = (12 + Math.random() * 70) + '%';
      surge.style.top = (14 + Math.random() * 56) + '%';
    }
    surge.hidden = !orbShown;
    document.title = fmt(s.essence) + ' - {{NAME}}';
    $('mult').textContent = 'x' + fmt(game.globalMult()) + ' global';
  }

  /* ---------- the loop ---------- */

  function frame() {
    var now = Date.now();
    var dt = Math.min(Math.max(0, (now - lastFrame) / 1000), 3600);
    lastFrame = now;
    announce(game.tick(dt, now));
    if (game.updateOrb(now, Math.random())) toast('A Rift Surge is open. Catch the glowing orb!');
    updateStage(now);
    if (tab === 'generators') updateGenerators();
    if (tab === 'upgrades') updateUpgrades();
    if (tab === 'ascension') updateShards();
    if (tab === 'stats') updateStats();
    if (now - lastSave > 15000) writeSave();
    requestAnimationFrame(frame);
  }

  function start() {
    load();
    buildGenerators(); buildUpgrades(); buildShards(); buildStats(); setupStage();
    showTab();
    document.addEventListener('visibilitychange', function () { if (document.hidden) writeSave(); });
    window.addEventListener('beforeunload', writeSave);
    requestAnimationFrame(frame);
  }

  start();
})();
`;

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:">
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="app">
    <header class="top">
      <h1>{{NAME}}</h1>
      <div class="chips"><span class="chip" id="mult">x1 global</span><span id="surge-banner" class="chip hot"></span></div>
    </header>

    <main class="layout">
      <section class="stage" id="stage" aria-label="Play area">
        <div class="readout">
          <div class="essence" id="essence">0</div>
          <div class="label">essence</div>
          <div class="eps" id="eps">0 essence per second</div>
        </div>
        <button class="orb" id="orb" type="button" aria-label="Gather essence"><span class="core"></span></button>
        <div class="click-value" id="click-value">+1 per click</div>
        <button class="surge" id="surge" type="button" hidden aria-label="Catch the Rift Surge"></button>
      </section>

      <section class="panel" aria-label="Upgrades and stats">
        <nav class="tabs" role="tablist">
          <button class="tab on" data-tab="generators" role="tab" type="button">Generators</button>
          <button class="tab" data-tab="upgrades" role="tab" type="button">Upgrades</button>
          <button class="tab" data-tab="ascension" role="tab" type="button">Ascension</button>
          <button class="tab" data-tab="stats" role="tab" type="button">Stats</button>
        </nav>

        <div class="page" id="page-generators">
          <div class="amounts" role="group" aria-label="Buy amount">
            <span>Buy</span>
            <button class="amt on" data-amount="1" type="button">1</button>
            <button class="amt" data-amount="10" type="button">10</button>
            <button class="amt" data-amount="100" type="button">100</button>
            <button class="amt" data-amount="max" type="button">Max</button>
          </div>
          <div class="list" id="generators"></div>
        </div>

        <div class="page" id="page-upgrades" hidden>
          <p class="note" id="up-count"></p>
          <div class="list" id="upgrades-list"></div>
        </div>

        <div class="page" id="page-ascension" hidden>
          <p class="note">Ascending resets your generators, upgrades and essence. In return you keep shards: permanent power that multiplies everything.</p>
          <p class="note strong" id="shards-owned"></p>
          <button class="primary" id="ascend" type="button" disabled>Ascend</button>
          <p class="math" id="ascend-math"></p>
          <div class="list" id="shard-list"></div>
        </div>

        <div class="page" id="page-stats" hidden>
          <div class="stats" id="stat-rows"></div>
          <h2>Achievements</h2>
          <p class="note" id="ach-count"></p>
          <ul class="achs" id="ach-list"></ul>
          <h2>Save</h2>
          <p class="note">The game saves itself every few seconds. Copy a save out, or paste one in.</p>
          <textarea id="save-box" rows="3" spellcheck="false" aria-label="Save text"></textarea>
          <div class="buttons"><button id="export" type="button">Export</button><button id="import" type="button">Import</button><button id="reset" type="button" class="danger">Erase save</button></div>
        </div>
      </section>
    </main>
    <div class="toast" id="toast" role="status"></div>
  </div>
  <script src="game.js"></script>
  <script src="ui.js"></script>
</body>
</html>
`;

const STYLE_CSS = String.raw`:root {
  --bg: #07040d;
  --bg2: #0d0818;
  --panel: #120b20;
  --line: #2a1c45;
  --text: #ece6fa;
  --dim: #9a8cb8;
  --purple: #a855f7;
  --purple2: #7c3aed;
  --glow: rgba(168, 85, 247, 0.55);
  --gold: #fbbf24;
  --good: #34d399;
  color-scheme: dark;
}
* { box-sizing: border-box; }
* { scrollbar-width: thin; scrollbar-color: #3b2766 transparent; }
html, body { height: 100%; }
body {
  margin: 0;
  background: radial-gradient(1200px 700px at 25% 40%, #1a0d33 0%, var(--bg) 60%);
  color: var(--text);
  font: 15px/1.45 "Segoe UI", system-ui, sans-serif;
  overflow: hidden;
}
.app { height: 100%; display: flex; flex-direction: column; }
.top { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.top h1 { margin: 0; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--purple); }
.chips { display: flex; gap: 8px; }
.chip { padding: 3px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--dim); font-size: 12px; }
.chip.hot { color: var(--gold); border-color: var(--gold); }
.chip.hot:empty { display: none; }

.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, 1fr) minmax(340px, 460px); }
.stage { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 20px; overflow: hidden; }
.stage.surging { box-shadow: inset 0 0 120px rgba(251, 191, 36, 0.12); }
.readout { text-align: center; }
.essence { font-size: clamp(40px, 7vw, 72px); font-weight: 700; letter-spacing: -0.02em; text-shadow: 0 0 30px var(--glow); font-variant-numeric: tabular-nums; }
.label { color: var(--dim); text-transform: uppercase; letter-spacing: 0.25em; font-size: 12px; }
.eps { margin-top: 6px; color: var(--purple); }
.click-value { color: var(--dim); font-size: 13px; }

.orb {
  width: clamp(160px, 28vmin, 240px); aspect-ratio: 1; border: 0; border-radius: 50%; cursor: pointer; padding: 0;
  background: radial-gradient(circle at 35% 30%, #d8b4fe 0%, var(--purple) 28%, var(--purple2) 58%, #2e1065 100%);
  box-shadow: 0 0 60px var(--glow), inset 0 0 40px rgba(0, 0, 0, 0.45);
  transition: transform 0.08s ease;
  animation: breathe 4s ease-in-out infinite;
  touch-action: manipulation;
}
.orb:hover { transform: scale(1.03); }
.orb:active { transform: scale(0.96); }
.orb:focus-visible { outline: 2px solid #fff; outline-offset: 6px; }
.orb .core { display: block; width: 100%; height: 100%; border-radius: 50%; background: radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.35), transparent 55%); }
.orb.pulse { animation: pop 0.25s ease-out; }
@keyframes breathe { 0%, 100% { box-shadow: 0 0 50px var(--glow), inset 0 0 40px rgba(0, 0, 0, 0.45); } 50% { box-shadow: 0 0 90px var(--glow), inset 0 0 40px rgba(0, 0, 0, 0.45); } }
@keyframes pop { 0% { transform: scale(0.94); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }

.surge {
  position: absolute; width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer;
  background: radial-gradient(circle, #fff6c4 0%, var(--gold) 45%, #b45309 100%);
  box-shadow: 0 0 36px rgba(251, 191, 36, 0.8);
  animation: bob 1.4s ease-in-out infinite;
}
.surge[hidden] { display: none; }
@keyframes bob { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-8px) scale(1.08); } }

.float { position: absolute; pointer-events: none; font-weight: 700; color: #fff; text-shadow: 0 0 10px var(--purple); animation: rise 0.95s ease-out forwards; z-index: 5; white-space: nowrap; }
.float.buy { color: var(--good); text-shadow: none; }
@keyframes rise { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-70px); } }

.panel { background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.tabs { display: flex; border-bottom: 1px solid var(--line); }
.tab { flex: 1; padding: 12px 6px; background: transparent; border: 0; color: var(--dim); font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--text); border-bottom-color: var(--purple); }
.page { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.page[hidden] { display: none; }
.amounts { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; color: var(--dim); font-size: 13px; }
.amt { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; font: inherit; }
.amt.on { background: var(--purple2); border-color: var(--purple); color: #fff; }
.list { display: flex; flex-direction: column; gap: 8px; }

.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); font: inherit; cursor: pointer; }
.row:disabled { opacity: 0.45; cursor: not-allowed; }
.row.can { border-color: var(--purple2); box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.25); }
.row.can:hover { background: #1a1030; }
.row.locked { opacity: 0.3; }
.row.flash { animation: flash 0.35s ease-out; }
@keyframes flash { from { background: #3b1d6e; } to { background: var(--bg2); } }
.row.owned { border-color: var(--good); opacity: 0.8; }
.row-main { min-width: 0; flex: 1; }
.row-name { display: flex; align-items: baseline; gap: 10px; font-weight: 600; }
.row-name .count { margin-left: auto; color: var(--purple); font-variant-numeric: tabular-nums; font-size: 20px; }
.row-sub { color: var(--dim); font-size: 12px; }
.row-rate { color: #c4b5fd; font-size: 12px; margin-top: 2px; }
.row-cost { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--gold); font-weight: 600; }

.note { color: var(--dim); font-size: 13px; margin: 0 0 10px; }
.note.strong { color: var(--text); }
.math { color: var(--dim); font-size: 12px; font-family: Consolas, monospace; }
.empty { color: var(--dim); text-align: center; padding: 24px 0; }
.primary { width: 100%; padding: 12px; border-radius: 10px; border: 0; background: linear-gradient(135deg, var(--purple2), var(--purple)); color: #fff; font: inherit; font-weight: 700; cursor: pointer; margin-bottom: 8px; }
.primary:disabled { background: var(--bg2); color: var(--dim); cursor: not-allowed; border: 1px solid var(--line); }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--purple); margin: 18px 0 6px; }
.stat { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--line); }
.stat .k { color: var(--dim); }
.stat .v { font-variant-numeric: tabular-nums; }
.achs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.ach { display: flex; flex-direction: column; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; opacity: 0.45; font-size: 13px; }
.ach span { color: var(--dim); font-size: 12px; }
.ach.got { opacity: 1; border-color: var(--purple2); }
textarea { width: 100%; background: var(--bg2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: 12px Consolas, monospace; resize: vertical; }
.buttons { display: flex; gap: 8px; margin-top: 8px; }
.buttons button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); font: inherit; cursor: pointer; }
.buttons .danger { margin-left: auto; color: #fca5a5; border-color: #7f1d1d; }

.toast { position: fixed; left: 50%; bottom: 20px; transform: translate(-50%, 20px); max-width: 80vw; padding: 10px 16px; background: #1f1238; border: 1px solid var(--purple2); border-radius: 10px; opacity: 0; pointer-events: none; transition: opacity 0.25s, transform 0.25s; z-index: 20; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 760px) {
  body { overflow: auto; }
  .layout { grid-template-columns: 1fr; }
  .panel { border-left: 0; border-top: 1px solid var(--line); min-height: 60vh; }
}
@media (prefers-reduced-motion: reduce) {
  .orb, .surge, .float { animation: none; }
  .toast { transition: none; }
}
`;

const MAIN_JS = String.raw`// The desktop window around the game. Everything the game does happens in index.html.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#07040d',
    autoHideMenuBar: true,
    title: '{{NAME}}',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
`;

const TEST_JS = String.raw`// Checks the maths in game.js. Run with: npm test
const assert = require('assert');
const G = require('./game.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  ' + name); }

test('numbers are formatted into short names', () => {
  assert.strictEqual(G.fmt(0), '0');
  assert.strictEqual(G.fmt(7.5), '7.5');
  assert.strictEqual(G.fmt(999), '999');
  assert.strictEqual(G.fmt(1500), '1.5K');
  assert.strictEqual(G.fmt(2.5e6), '2.5M');
  assert.strictEqual(G.fmt(4.2e12), '4.2T');
  assert.strictEqual(G.fmt(999999.9), '1M');
  assert.strictEqual(G.fmt(1.23e45), '1.23e45');
  assert.strictEqual(G.fmtFull(1234567), '1,234,567');
});

test('the price of n units matches buying them one at a time', () => {
  for (let i = 0; i < G.GENERATORS.length; i++) {
    for (const owned of [0, 1, 7, 40]) {
      let sum = 0;
      for (let k = 0; k < 25; k++) sum += G.GENERATORS[i].base * Math.pow(G.GROWTH, owned + k);
      const closed = G.costOf(i, owned, 25);
      assert.ok(Math.abs(closed - sum) / sum < 1e-9, 'generator ' + i + ' owned ' + owned);
    }
  }
});

test('maxBuyable buys the most it can afford and no more', () => {
  for (let i = 0; i < G.GENERATORS.length; i++) {
    for (const owned of [0, 3, 50]) {
      for (const budget of [1, 100, 5e4, 7.7e9, 3e15]) {
        const n = G.maxBuyable(i, owned, budget);
        assert.ok(G.costOf(i, owned, n) <= budget, 'affordable');
        assert.ok(G.costOf(i, owned, n + 1) > budget, 'cannot afford one more');
      }
    }
  }
});

test('a fresh game starts empty and the first click pays 1', () => {
  const g = G.createGame({ now: 0 });
  assert.strictEqual(g.state.essence, 0);
  assert.strictEqual(g.eps(0), 0);
  assert.strictEqual(g.click(0).gain, 1);
  assert.strictEqual(g.state.essence, 1);
});

test('buying a generator spends the right amount and produces', () => {
  const g = G.createGame({ now: 0 });
  g.state.essence = 15;
  assert.strictEqual(g.buy(0, 1), 1);
  assert.strictEqual(g.state.essence, 0);
  const rate = G.GENERATORS[0].rate;
  assert.ok(Math.abs(g.eps(0) - rate) < 1e-12);
  g.tick(10, 0);
  assert.ok(Math.abs(g.state.essence - rate * 10) < 1e-9);
});

test('buying without enough essence does nothing', () => {
  const g = G.createGame({ now: 0 });
  g.state.essence = 14;
  assert.strictEqual(g.buy(0, 1), 0);
  assert.strictEqual(g.state.owned[0], 0);
});

test('milestones double a generator at 10 and 25 owned', () => {
  const g = G.createGame({ now: 0 });
  const r = G.GENERATORS[0].rate;
  g.state.owned[0] = 9; g.refresh();
  assert.ok(Math.abs(g.eps(0) - 9 * r) < 1e-9);
  g.state.owned[0] = 10; g.refresh();
  assert.ok(Math.abs(g.eps(0) - 10 * r * 2) < 1e-9);
  g.state.owned[0] = 25; g.refresh();
  assert.ok(Math.abs(g.eps(0) - 25 * r * 4) < 1e-9);
});

test('upgrades multiply and are bought once', () => {
  const g = G.createGame({ now: 0 });
  g.state.essence = 1e6; g.state.run = 1e6;
  assert.ok(g.buyUpgrade('hand1'));
  assert.ok(!g.buyUpgrade('hand1'));
  assert.strictEqual(g.click(0).gain, 2);
});

test('an upgrade for a generator you do not own yet is not available', () => {
  const g = G.createGame({ now: 0 });
  g.state.essence = 1e9; g.state.run = 1e9;
  assert.ok(!g.buyUpgrade('gen0I'));
  g.state.owned[0] = 1;
  assert.ok(g.buyUpgrade('gen0I'));
});

test('ascending pays cbrt(run / 1e9) shards, resets the run and keeps the shards', () => {
  const g = G.createGame({ now: 0 });
  g.state.run = 8e9; g.state.all = 8e9; g.state.essence = 5; g.state.owned[0] = 30;
  assert.strictEqual(g.pendingShards(), 2);
  assert.strictEqual(g.ascend(1000), 2);
  assert.strictEqual(g.state.shards, 2);
  assert.strictEqual(g.state.essence, 0);
  assert.strictEqual(g.state.owned[0], 0);
  assert.strictEqual(g.state.ascensions, 1);
  assert.ok(g.achievementCount() >= 1, 'Reborn unlocks on the first ascension');
  assert.ok(Math.abs(g.globalMult() - 1.04 * (1 + 0.01 * g.achievementCount())) < 1e-9);
});

test('shards need a billion essence before the first one', () => {
  const g = G.createGame({ now: 0 });
  g.state.run = 9.9e8;
  assert.strictEqual(g.pendingShards(), 0);
  assert.strictEqual(g.ascend(0), 0);
});

test('shard upgrades cost shards and apply', () => {
  const g = G.createGame({ now: 0 });
  g.state.shards = 3; g.state.shardsTotal = 3;
  assert.ok(g.buyShardUpgrade('echo'));
  assert.ok(!g.buyShardUpgrade('echo'));
  assert.strictEqual(g.state.shards, 1);
  assert.ok(g.click(0).gain >= 2);
});

test('a Rift Surge multiplies production while it lasts', () => {
  const g = G.createGame({ now: 0 });
  g.state.owned[0] = 1; g.state.nextOrbAt = 0; g.refresh();
  assert.ok(g.updateOrb(1, 0.5));
  assert.ok(g.orbVisible(2));
  assert.ok(g.catchOrb(2));
  // Catching it unlocks an achievement, so measure the plain rate afterwards.
  const plain = g.eps(2 + g.data.SURGE_SECONDS * 1000 + 1);
  assert.ok(Math.abs(g.eps(3) - plain * g.data.SURGE_MULT) < 1e-9);
  assert.ok(!g.catchOrb(3));
});

test('offline progress is capped, reduced and ignored when short', () => {
  const g = G.createGame({ now: 0 });
  g.state.owned[0] = 10; g.state.savedAt = 0;
  assert.strictEqual(g.applyOffline(30 * 1000), null);
  const rate = g.eps(0);
  const out = g.applyOffline(100 * 3600 * 1000);
  assert.ok(Math.abs(out.gain - rate * 8 * 3600 * 0.25) < 1e-6);
});

test('a save round-trips and a damaged save falls back to a fresh game', () => {
  const g = G.createGame({ now: 0 });
  g.state.essence = 123; g.state.owned[2] = 4; g.state.upgrades.hand1 = true;
  const copy = G.createGame({ state: JSON.parse(g.serialize(50)), now: 60 });
  assert.strictEqual(copy.state.essence, 123);
  assert.strictEqual(copy.state.owned[2], 4);
  assert.ok(copy.state.upgrades.hand1);
  const bad = G.createGame({ state: { essence: 'lots', owned: 7, upgrades: 3 }, now: 0 });
  assert.strictEqual(bad.state.essence, 0);
  assert.strictEqual(bad.state.owned.length, G.GENERATORS.length);
});

test('achievements unlock and add 1% each', () => {
  const g = G.createGame({ now: 0 });
  const before = g.globalMult();
  const out = g.click(0);
  assert.ok(out.achievements.length >= 1);
  assert.ok(g.globalMult() > before);
});

test('trillions are reachable and stay finite', () => {
  const g = G.createGame({ now: 0 });
  g.state.owned = g.state.owned.map(() => 200);
  g.state.shardsTotal = 100;
  g.refresh();
  const e = g.eps(0);
  assert.ok(isFinite(e) && e > 1e10, 'eps ' + e);
  g.tick(3600, 0);
  assert.ok(isFinite(g.state.essence) && g.state.essence > 1e13, 'essence ' + g.state.essence);
  assert.ok(G.fmt(g.state.essence).length < 12);
});

console.log('\n' + passed + ' checks passed');
`;

const PACKAGE_JSON = String.raw`{
  "name": "{{ID}}",
  "version": "1.0.0",
  "description": "{{NAME}} - an incremental clicker game.",
  "main": "main.js",
  "private": true,
  "scripts": {
    "start": "electron .",
    "test": "node test.js"
  },
  "devDependencies": {
    "electron": "^33.2.0"
  }
}
`;

const PLAY_CMD = [
  '@echo off',
  'cd /d "%~dp0"',
  'if exist "node_modules\\electron\\dist\\electron.exe" (',
  '  start "" "node_modules\\electron\\dist\\electron.exe" .',
  ') else (',
  '  start "" "index.html"',
  ')',
  '',
].join('\r\n');

const README = String.raw`# {{NAME}}

An incremental clicker game. Click the orb, buy generators, find upgrades, ascend for permanent
power, and watch the numbers climb into the trillions and beyond.

## Play

Double-click **Play.cmd**. It opens the desktop window if Electron is installed
(run \`npm install\` once to get it), and the game in your browser if it is not.

## How the numbers work

| Thing | Rule |
| --- | --- |
| Price of the next unit | \`base x 1.15 ^ owned\` |
| Price of n units | \`base x 1.15 ^ owned x (1.15 ^ n - 1) / 0.15\` |
| Milestones | every generator doubles at 10, 25, 50, 100, 150, 200, 250, 300, 350, 400 owned |
| Upgrades | multiply a generator, your clicks, or everything; synergies add a percentage per unit of another generator |
| Rift Surge | a golden orb appears every minute or two; catching it makes everything x7 for 30 seconds |
| Ascension | \`floor( cbrt( essence earned this run / 1e9 ) )\` shards; each earned shard is +2% to everything |
| Achievements | each is +1% to everything |
| Offline | up to 8 hours away pays 25% of your rate (60% after the Slumbering Power shard upgrade) |

## Files

- \`game.js\` - the rules; pure logic with no screen in it
- \`ui.js\`, \`index.html\`, \`style.css\` - what you see
- \`main.js\` - the desktop window
- \`test.js\` - run \`npm test\` to check the maths

Progress is saved in the app's own storage every few seconds. Stats has export and import for moving a save.
`;

export function clickerFiles(options: TemplateOptions): TemplateFile[] {
  const fill = (text: string) => text.replace(/\{\{NAME\}\}/g, options.name).replace(/\{\{ID\}\}/g, options.id);
  return [
    { path: 'index.html', content: fill(INDEX_HTML) },
    { path: 'style.css', content: fill(STYLE_CSS) },
    { path: 'game.js', content: fill(GAME_JS) },
    { path: 'ui.js', content: fill(UI_JS) },
    { path: 'main.js', content: fill(MAIN_JS) },
    { path: 'test.js', content: fill(TEST_JS) },
    { path: 'package.json', content: fill(PACKAGE_JSON) },
    { path: 'Play.cmd', content: PLAY_CMD },
    { path: 'README.md', content: fill(README.replace(/\\`/g, '`')) },
  ];
}
