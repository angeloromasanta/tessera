/* TesseraGame — the client of the poll service's game layer (docs/game.md).
 *
 * Canonical copy: tessera/slides/src/game-sdk.js. It is opt-in: a page that
 * contains <meta name="tessera-game"> gets it injected — after TESSERA_EMBED and
 * the live shim in a deck embed (render.ts), after TESSERA_ACTIVITY and live.js
 * in an activity page on the phones (the poll worker serves an identical copy
 * as /game.js; `npm run sync` in server/poll-worker copies it).
 *
 * Why it exists: every classroom game used to rebuild the same ~400 lines of
 * plumbing on top of answer buckets (who is playing, the last answer per
 * player, the screen's state broadcast through a twin bucket). The service now
 * does that once, and this file is the one way a page talks to it:
 *
 *   const g = TesseraGame.connect()          // role, code, service: detected
 *   g.onState(function (state) { ... })     // everyone: the screen's state
 *   g.move('bid', 40)                       // a phone plays
 *   g.onMoves(function (moves) { ... })     // the screen sees the plays
 *   g.publish({round: 2}, {accept: {moves: ['r2']}})
 *
 * Transport: plain fetch, read every `tick` ms while the page is visible. The
 * live shim (live-shim.js) answers those reads from its cache until the server
 * says the code changed, so a timer read costs nothing when nothing happened.
 *
 * With no service at all (a poster render, the page opened on its own) the
 * same API runs against TesseraGame.mock(), an in-memory copy of the server's
 * rules, and g.sample is true; g.fake(name) then makes simulated phones. A page
 * is written once and can be built and rehearsed with no network.
 *
 * Plain ES2017, no imports. This file is inlined into srcdoc pages, so it must
 * never contain a closing script tag, not even in a comment.
 *
 * Pages written before the rename use the old names: legacy-names.js, which
 * runs ahead of this file in a deck embed, maps them onto these.
 */
(function () {
  'use strict';
  if (window.TesseraGame) return;

  var KEY_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
  // The server's limits (api/_lib.js), mirrored by the mock.
  var LIM = { players: 500, moves: 10000, data: 4000, state: 100000, priv: 4000, name: 60, page: 2000 };
  // The global each vendored library defines, so g.lib() can resolve with it.
  var LIB_GLOBAL = { confetti: 'confetti', matter: 'Matter', d3: 'd3', chart: 'Chart' };

  function err(status, body) {
    body = body || {};
    var e = new Error(body.error || ('HTTP ' + status));
    e.status = status;
    e.body = body;
    e.taken = status === 409 && body.error === 'taken';
    e.closed = !!body.closed;
    e.kicked = !!body.kicked;
    e.joined = body.joined !== false;
    if (body.by) e.by = body.by;
    if (body.at) e.at = body.at;
    return e;
  }
  function token() {
    var a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_', s = '';
    var r = new Uint8Array(24);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(r) : r.forEach(function (_, i) { r[i] = Math.random() * 256; });
    for (var i = 0; i < 24; i++) s += a[r[i] & 63];
    return s;
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function size(v) { return v === undefined ? 0 : JSON.stringify(v).length; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  // ———————————————————————————————————————— the mock service
  // The server's semantics in memory: players, moves (last / first / slot),
  // accept, state with compare-and-set, private values, kick, reset, since.
  // request() answers exactly what the real /api/game would, as {status, body}.
  function mock() {
    var games = {};
    function game(code) {
      return games[code] || (games[code] = {
        v: 0, epoch: token().slice(0, 8), state: {}, accept: null,
        players: {}, rows: {}, seq: 0, priv: {},
      });
    }
    // pid: a stable, opaque id per (code, device token), like the server's
    // sha256 one but a cheap FNV hash: the mock has no secret to protect.
    function pidOf(code, tok) {
      var h1 = 0x811c9dc5, h2 = 0x1b873593, s = code + ':' + tok, out = '';
      for (var i = 0; i < s.length; i++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519);
      }
      var a = 'abcdefghijklmnopqrstuvwxyz234567';
      for (var j = 0; j < 12; j++) out += a[((j < 6 ? h1 : h2) >>> ((j % 6) * 5)) & 31];
      return out;
    }
    function open(acc, k, now) {
      if (!acc) return true;
      if (acc.until && now > acc.until) return false;
      if (acc.moves === null || acc.moves === undefined) return true;
      return acc.moves.some(function (p) {
        return p.slice(-1) === '*' ? k.indexOf(p.slice(0, -1)) === 0 : p === k;
      });
    }
    function list(G) {
      return Object.keys(G.rows).map(function (o) { return G.rows[o]; })
        .sort(function (a, b) { return a.seq - b.seq; });
    }
    function get(G, code, q, pid, key) {
      var out = { code: code, v: G.v, epoch: G.epoch, state: clone(G.state), accept: clone(G.accept), now: Date.now(), count: 0 };
      var ps = Object.keys(G.players).map(function (p) { return G.players[p]; });
      out.count = ps.filter(function (p) { return !p.kicked; }).length;
      if (pid) {
        var p = G.players[pid], moves = {};
        list(G).forEach(function (m) {
          if (m.pid === pid) moves[m.k] = m.slot ? { data: clone(m.data), at: m.at, seq: m.seq, slot: m.slot } : { data: clone(m.data), at: m.at, seq: m.seq };
        });
        out.me = { pid: pid, name: p ? p.name : '', joined: !!p, kicked: !!(p && p.kicked), private: G.priv[pid] === undefined ? null : clone(G.priv[pid]), moves: moves };
      }
      if (key) {
        var since = q.since === undefined ? -1 : Number(q.since);
        out.players = ps.map(function (p) { return { pid: p.pid, name: p.name, at: p.at, kicked: p.kicked }; });
        // paged like the server: at most LIM.page moves, `more` when cut,
        // `seq` then the last one returned so the next read continues there
        var ms = list(G).filter(function (m) { return m.seq > since; });
        out.seq = G.seq;
        if (ms.length > LIM.page) { ms = ms.slice(0, LIM.page); out.more = true; out.seq = ms[ms.length - 1].seq; }
        out.moves = ms.map(clone);
      }
      return out;
    }
    function post(G, b, pid, key) {
      var now = Date.now();
      if (b.op === 'join') {
        if (!pid) return [400, { error: 'no player token' }];
        var p = G.players[pid];
        if (!p && G.accept && G.accept.join === false) return [403, { error: 'joining is closed', closed: true }];
        if (!p && Object.keys(G.players).length >= LIM.players) return [429, { error: 'game is full' }];
        var name = String(b.name || '').trim().slice(0, LIM.name);
        G.players[pid] = p = { pid: pid, name: name || (p && p.name) || '', at: p ? p.at : now, kicked: false };
        return [200, { pid: pid, epoch: G.epoch, name: p.name }];
      }
      if (b.op === 'move') {
        var me = pid && G.players[pid];
        if (!me) return [403, { error: 'not joined', joined: false }];
        if (me.kicked) return [403, { error: 'kicked', kicked: true }];
        if (!KEY_RE.test(String(b.k))) return [400, { error: 'bad key' }];
        if (b.slot !== undefined && b.slot !== null && b.slot !== '' && !KEY_RE.test(String(b.slot))) return [400, { error: 'bad slot' }];
        if (size(b.data) > LIM.data) return [413, { error: 'move too large' }];
        if (!open(G.accept, b.k, now)) return [403, { error: 'closed', closed: true }];
        var owner = b.slot ? 'slot:' + b.slot : pid, rk = owner + '|' + b.k, old = G.rows[rk];
        if (b.mode === 'first' && old) return [409, { error: 'taken', by: old.pid, at: old.at }];
        if (!old && Object.keys(G.rows).length >= LIM.moves) return [429, { error: 'too many moves' }];
        var row = { seq: ++G.seq, pid: pid, k: String(b.k), data: b.data === undefined ? null : clone(b.data), at: now };
        if (b.slot) row.slot = String(b.slot);
        G.rows[rk] = row;
        return [200, { ok: true, seq: row.seq, at: now }];
      }
      if (!key) return [401, { error: 'lecturer key required' }];
      if (b.op === 'state') {
        if (b.ifV !== undefined && b.ifV !== null && b.ifV !== G.v) return [409, { error: 'stale', v: G.v, state: clone(G.state) }];
        if (b.state !== undefined && size(b.state) > LIM.state) return [413, { error: 'state too large' }];
        var pv = b.private || {};
        for (var id in pv) if (size(pv[id]) > LIM.priv) return [413, { error: 'private too large' }];
        if (b.state !== undefined) G.state = clone(b.state);
        if ('accept' in b) G.accept = clone(b.accept);
        for (var id2 in pv) { if (pv[id2] === null) delete G.priv[id2]; else G.priv[id2] = clone(pv[id2]); }
        return [200, { v: ++G.v }];
      }
      if (b.op === 'kick') {
        if (G.players[b.pid]) G.players[b.pid].kicked = true;
        return [200, { ok: true }];
      }
      if (b.op === 'reset') {
        G.players = {}; G.rows = {}; G.priv = {}; G.state = {}; G.accept = null;
        G.epoch = token().slice(0, 8);
        return [200, { v: ++G.v, epoch: G.epoch }];
      }
      return [400, { error: 'unknown op' }];
    }
    return {
      games: games,
      /** One request, as the server would answer it. `who`: {player, key}. */
      request: function (method, code, q, body, who) {
        code = String(code || '').toLowerCase();
        var G = game(code), pid = who.player ? pidOf(code, who.player) : '';
        var r = method === 'GET' ? [200, get(G, code, q || {}, pid, !!who.key)] : post(G, body || {}, pid, !!who.key);
        // async like the network, and never sharing objects with the caller
        return Promise.resolve({ status: r[0], body: clone(r[1]) });
      },
    };
  }

  // ———————————————————————————————————————— deck messages (present mode)
  // render.ts/present.ts post {tessera:'slide', on, id, index} when this frame's
  // slide is entered or left; goto asks the deck to move ('next', 'prev', a
  // slide id or a 0-based index). Outside a deck both are inert.
  var slide = (function () {
    var fns = { enter: [], leave: [] };
    var api = {
      active: null, id: null, index: null,
      on: function (ev, fn) { (fns[ev] || (fns[ev] = [])).push(fn); return api; },
      goto: function (to) { if (window.parent !== window) window.parent.postMessage({ tessera: 'goto', to: to }, '*'); },
    };
    addEventListener('message', function (e) {
      var d = e.data;
      if (e.source !== window.parent || !d || d.tessera !== 'slide') return;
      if (api.active === !!d.on) return; // a repeat (a lazy frame's ready) changes nothing
      api.active = !!d.on; api.id = d.id; api.index = d.index;
      (fns[d.on ? 'enter' : 'leave'] || []).forEach(function (fn) { try { fn(d); } catch (x) { console.error(x); } });
    });
    return api;
  })();

  var sampleServer = null; // one mock per page, shared by the screen and g.fake phones

  // ———————————————————————————————————————— connect
  function connect(opts) {
    opts = opts || {};
    var E = window.TESSERA_EMBED, A = window.TESSERA_ACTIVITY;
    var EP = (E && E.poll) || {};
    var role = opts.role || (A ? 'phone' : 'screen');
    var phone = role === 'phone';
    var code = String((A && A.code) || (EP.previous && EP.previous.code) || opts.code || '').toLowerCase();
    // A phone's page is served by the join page: relative URLs reach the service.
    var service = phone ? (A ? '' : opts.service || '') : (EP.service || opts.service || '');
    var real = !opts.mock && !!code && (phone ? !!A || !!opts.service : !!service);
    var server = real ? null : opts._server || (sampleServer = sampleServer || mock());
    var key = phone ? '' : (real ? EP.lecturer || '' : 'sample');
    var player = phone ? (opts._player || (A && A.player) || token()) : '';
    var name = phone ? (opts._name !== undefined ? opts._name : (A && A.name) || '') : '';
    var tick = opts.tick > 0 ? opts.tick : 2000;

    var g = {
      role: role, code: code || 'sample', service: service, sample: !real, hasKey: !!key,
      state: undefined, v: undefined, epoch: undefined, accept: null, count: 0,
      me: null, players: [], moves: [], error: null, slide: slide,
    };
    var skew = 0, since = 0, fns = { state: [], me: [], moves: [], players: [] };
    var busy = false, again = false, timer = 0, closed = false, autoKey = '', joining = null;

    function fire(list, a) { list.forEach(function (fn) { try { fn(a, g); } catch (x) { console.error(x); } }); }

    // One request to /api/game (or /api/ai): {status, body}, never rejects on HTTP.
    function call(method, path, q, body) {
      var who = { player: player, key: key };
      if (!real) {
        if (path !== '/api/game') return Promise.resolve({ status: 200, body: sampleAi(body) });
        return server.request(method, g.code, q, body, who);
      }
      var url = service + path + '?c=' + encodeURIComponent(g.code);
      for (var k in q) if (q[k] !== undefined) url += '&' + k + '=' + encodeURIComponent(q[k]);
      var h = {};
      if (key) h['x-tessera-lecturer'] = key;
      if (player) h['x-tessera-player'] = player;
      if (body) h['content-type'] = 'application/json';
      return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; }); });
    }
    function sampleAi(body) {
      var t = '(sample) ' + String(body.task || 'ai') + ': ' + String(body.input || '').slice(0, 80);
      return body.json ? { text: '{}', json: {} } : { text: t };
    }
    function write(body, path) {
      body.code = g.code;
      return call('POST', path || '/api/game', null, body).then(function (r) {
        if (r.status >= 400) throw err(r.status, r.body);
        if (!path) read();
        return r.body;
      });
    }

    // ——— reading
    function read() {
      if (closed) return;
      if (busy) { again = true; return; }
      busy = true;
      var q = key && !phone && since > 0 ? { since: since } : null;
      call('GET', '/api/game', q).then(function (r) {
        if (r.status >= 400) throw err(r.status, r.body);
        apply(r.body, !!q);
        g.error = null;
      }).catch(function (e) { g.error = e; }).then(function () {
        busy = false;
        if (again) { again = false; read(); }
      });
    }
    function apply(d, usedSince) {
      if (typeof d.now === 'number') skew = d.now - Date.now();
      g.count = d.count || 0;
      g.accept = d.accept === undefined ? null : d.accept;
      var reset = g.epoch !== undefined && d.epoch !== g.epoch;
      g.epoch = d.epoch;
      if (reset) {
        g.moves = []; g.players = []; since = 0;
        // moves read "since" the old epoch's seq may miss the new epoch's: read all
        if (usedSince) again = true;
      }
      if (d.v !== g.v || reset) {
        g.v = d.v; g.state = d.state;
        fire(fns.state, g.state);
      }
      if (phone && d.me) {
        if (!same(d.me, g.me)) { g.me = d.me; fire(fns.me, g.me); }
        autoJoin();
      }
      if (d.players) {
        if (!same(d.players, g.players)) { g.players = d.players; fire(fns.players, g.players); }
      }
      if (d.moves && !(reset && usedSince)) {
        var have = {}, fresh = [];
        g.moves.forEach(function (m) { have[m.seq] = 1; });
        d.moves.forEach(function (m) { if (!have[m.seq]) fresh.push(m); });
        if (fresh.length) {
          g.moves = g.moves.concat(fresh).sort(function (a, b) { return a.seq - b.seq; });
          fire(fns.moves, fresh);
        }
        since = typeof d.seq === 'number' ? d.seq : g.moves.length ? g.moves[g.moves.length - 1].seq : since;
        if (d.more) again = true; // a cut page (2000 moves): read on from `seq` at once
      }
    }
    // A phone with a known name joins by itself: on connect, and again after a
    // reset (a new epoch clears the roster). Never after a kick: me.kicked
    // shows, and the page decides whether to offer g.join().
    function autoJoin() {
      var me = g.me;
      if (!name || !me || me.joined || me.kicked || joining) return;
      var k = g.epoch + '|' + !(g.accept && g.accept.join === false);
      if (k === autoKey) return; // tried in this epoch with joining in this state
      autoKey = k;
      g.join().catch(function () {});
    }
    function loop() {
      clearTimeout(timer);
      if (closed) return;
      if (!document.hidden) read();
      timer = setTimeout(loop, tick);
    }
    function onVisible() { if (!document.hidden) read(); }
    document.addEventListener('visibilitychange', onVisible);

    // ——— everyone
    g.now = function () { return Date.now() + skew; };
    g.onState = function (fn) { fns.state.push(fn); if (g.v !== undefined) fn(g.state, g); return g; };
    g.ai = function (task, input, o) {
      o = o || {};
      var b = { task: task, input: input };
      ['image', 'json', 'system', 'model', 'max'].forEach(function (k) { if (o[k] !== undefined) b[k] = o[k]; });
      return write(b, '/api/ai');
    };
    var libs = {};
    g.lib = function (name) {
      if (libs[name]) return libs[name];
      var base = phone ? (real && !A ? service : '') : service;
      if (!real && !base) return Promise.reject(new Error('no service to load ' + name + ' from'));
      return libs[name] = new Promise(function (ok, no) {
        var s = document.createElement('script');
        s.src = base + '/lib/' + encodeURIComponent(name) + '.js';
        s.onload = function () { ok(window[LIB_GLOBAL[name] || name]); };
        s.onerror = function () { delete libs[name]; no(new Error('could not load ' + name)); };
        document.head.appendChild(s);
      });
    };
    g.refresh = read;
    g.close = function () { closed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };

    // ——— phone
    g.join = function (n) {
      if (n !== undefined) name = String(n);
      var p = joining = write({ op: 'join', name: name || '' });
      return p.then(function (r) { joining = null; return r; }, function (e) { joining = null; throw e; });
    };
    g.move = function (k, data, o) {
      o = o || {};
      var b = { op: 'move', k: k, data: data };
      if (o.mode) b.mode = o.mode;
      if (o.slot) b.slot = o.slot;
      return write(b);
    };
    g.onMe = function (fn) { fns.me.push(fn); if (g.me) fn(g.me, g); return g; };

    // ——— screen
    g.latest = function (k) {
      var out = new Map();
      g.moves.forEach(function (m) { if (m.k === k) out.set(m.slot || m.pid, m); });
      return out;
    };
    g.onMoves = function (fn) { fns.moves.push(fn); return g; };
    g.onPlayers = function (fn) { fns.players.push(fn); return g; };
    g.publish = function (state, o) {
      o = o || {};
      var b = { op: 'state' };
      if (state !== undefined) b.state = state;
      if ('accept' in o) b.accept = o.accept;
      if (o.private) b.private = o.private;
      if (o.ifV !== undefined) b.ifV = o.ifV;
      return write(b);
    };
    g.reset = function () { return write({ op: 'reset' }); };
    g.kick = function (pid) { return write({ op: 'kick', pid: pid }); };
    g.fake = function (n) {
      if (real) throw new Error('g.fake() is for the sample/mock service only');
      return connect({ role: 'phone', code: g.code, mock: true, tick: tick, _server: server, _player: token(), _name: n || 'Player' });
    };

    loop();
    return g;
  }

  // ———————————————————————————————————————— helpers
  /** Scale a fixed-size stage (w×h CSS px) into the frame, centred. A frame
   *  can run this before it has a size (a show started on this slide): scaling
   *  to 0 would blank it, so a zero-size frame keeps the last scale, and it is
   *  asked again on load, on resize, by a ResizeObserver and every second. */
  function fit(stage, w, h) {
    w = w || 1280; h = h || 720;
    var st = stage.style;
    st.position = 'absolute'; st.left = '50%'; st.top = '50%';
    st.width = w + 'px'; st.height = h + 'px'; st.transformOrigin = 'center';
    if (!st.transform) st.transform = 'translate(-50%,-50%)';
    document.documentElement.style.overflow = 'hidden';
    if (document.body) document.body.style.margin = '0';
    function go() {
      if (!innerWidth || !innerHeight) return;
      var s = Math.min(innerWidth / w, innerHeight / h);
      st.transform = 'translate(-50%,-50%) scale(' + s + ')';
    }
    addEventListener('resize', go); addEventListener('load', go); go();
    if (window.ResizeObserver) new ResizeObserver(go).observe(document.documentElement);
    setInterval(go, 1000);
    return go;
  }

  /** The QR, the address and the code the room joins with, from TESSERA_EMBED.
   *  Without a service (a page opened on its own) only the code shows. */
  function joinBox(el, o) {
    o = o || {};
    var P = (window.TESSERA_EMBED && window.TESSERA_EMBED.poll) || {};
    // a screen written before the rename styles the old class names too
    var L = window.TESSERA_LEGACY, old = (L && L.joinClass) || '';
    function cls(n) { return 'tessera-join-' + n + (old ? ' ' + old + n : ''); }
    var service = o.service || P.service || '';
    var join = o.code || (P.previous && P.previous.join) || P.session || (P.previous && P.previous.code) || 'sample';
    var fg = String(o.fg || '#1E2A3A');
    el.innerHTML = '';
    el.style.display = 'flex'; el.style.flexDirection = 'column'; el.style.alignItems = 'center';
    el.style.gap = '8px'; el.style.textAlign = 'center'; el.style.color = fg;
    if (service) {
      var img = document.createElement('img');
      img.className = cls('qr'); img.alt = '';
      img.src = service + '/api/qr?c=' + encodeURIComponent(join) + '&fg=' + fg.replace('#', '');
      img.style.cssText = 'width:100%;max-width:180px;aspect-ratio:1;display:block';
      img.onerror = function () { img.style.display = 'none'; };
      el.appendChild(img);
    }
    var addr = document.createElement('div');
    addr.className = cls('addr');
    addr.style.cssText = 'font-size:15px;opacity:.72';
    addr.textContent = service.replace(/^https?:\/\//, '').replace(/^www\./, '') || 'no poll service';
    el.appendChild(addr);
    var c = document.createElement('div');
    c.className = cls('code');
    c.style.cssText = 'font-size:30px;font-weight:700;letter-spacing:.06em;line-height:1';
    c.textContent = join;
    el.appendChild(c);
    return el;
  }

  window.TesseraGame = { connect: connect, fit: fit, joinBox: joinBox, mock: mock, slide: slide, version: 1 };
})();
