/* The poll service's read guard and live link, in one wrapper around fetch.
 *
 * Canonical copy: tessera/slides/src/live-shim.js. It runs in three places:
 * every figure the deck embeds (render.ts injects it), the deck window itself
 * (main.ts imports it, for the presenter's poll widget), and the join page and
 * every activity page on the phones (the poll worker serves an identical copy
 * as /live.js; `npm run sync` in server/poll-worker copies it, and the worker's
 * test fails when the two differ).
 *
 * Every read of the poll service is billed by someone: Firestore per document
 * on the old Vercel service, a daily request quota on the Cloudflare one. Pages
 * poll anyway — a figure's setInterval(pull, 2500), a phone following the
 * speaker — so this file makes polling cheap instead of rewriting the pages:
 *
 *   - A GET to /api/poll, /api/session or /api/remix is answered from the last
 *     reply for that URL while the page cannot be seen (a hidden tab, a frame
 *     scrolled or switched out of view).
 *   - Against a service with /api/live (the Cloudflare one), the first read of a
 *     poll or join code opens one WebSocket to it, and later reads are answered
 *     from the last reply until the server says that code changed. A page that
 *     asks every 2.5 s reaches the network only when there is news.
 *   - Against a service without it (the Vercel one), the socket fails twice and
 *     the page polls exactly as before, minus the hidden-page reads.
 *   - A POST whose JSON body names a `code` gets `?c=CODE` added to its URL, so
 *     the Cloudflare router never has to parse a large body (a photo) to route it.
 *   - The game layer (docs/game.md): a GET to /api/game is a read like the
 *     others. Without the lecturer key it listens on `c=CODE&ch=state`, the
 *     channel that wakes only for state, kick and reset, so sixty phones are
 *     not re-read on every one of sixty moves; with the key (the screen) it
 *     listens on `c=CODE`, which hears everything. A POST to /api/game or
 *     /api/ai is a write, and any write to a code invalidates EVERY channel of
 *     that code, so the writer's next read goes to the network.
 *   - Cached replies are kept apart by who asked: one with the lecturer key
 *     (`#k`) and one per player token (`#p:TOKEN`) never answer each other.
 *
 * Nothing else is touched: other URLs, other methods, and pages outside a deck
 * or the join page behave as before. Plain ES5-ish on purpose: it is injected
 * as text into pages of every vintage.
 */
(function () {
  var F = window.fetch;
  if (!F || window.__tesseraLive) return;
  var live = window.__tesseraLive = { topics: {}, noLive: {}, cache: {}, net: 0 };

  var seen = true;
  if (window.parent !== window) {
    try {
      new IntersectionObserver(function (es) { seen = es[es.length - 1].isIntersecting; })
        .observe(document.documentElement);
    } catch (e) {}
  }

  var READ = /\/api\/(poll|session|remix|game)$/;
  var WRITE = /\/api\/(answer|upload|help|draw|summarize|cluster|remix|poll|game|ai)$/;

  function parse(input) {
    var raw = typeof input === 'string' ? input : (input && input.url) || String(input);
    try { return new URL(raw, document.baseURI); } catch (e) { return null; }
  }
  /** The poll or join code a URL is about: "c=CODE" or "s=CODE". */
  function topicOf(u) {
    var s = u.searchParams.get('s'), c = u.searchParams.get('c');
    if (/\/api\/session$/.test(u.pathname)) return s ? 's=' + s.toLowerCase() : '';
    return c ? 'c=' + c.toLowerCase() : '';
  }
  /** A request header's value, from a plain object or a Headers. */
  function header(init, input, name) {
    var h = (init && init.headers) || (input && input.headers);
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) || '';
    for (var k in h) if (k.toLowerCase() === name && h[k]) return String(h[k]);
    return '';
  }
  /** A header under its name, or under the name a page written before the
   *  rename sets (legacy-names.js, when it ran on this page). */
  function named(init, input, kind) {
    var L = window.TESSERA_LEGACY, old = L && L.headers && L.headers[kind];
    return header(init, input, 'x-tessera-' + kind) || (old ? header(init, input, old) : '');
  }
  function hasKey(init, input) { return !!named(init, input, 'lecturer'); }
  /** A write to a code: every channel of that code ("c=CODE", "c=CODE&ch=…")
   *  is stale now, so the next read of any of them goes to the network. */
  function bump(origin, t) {
    if (!t) return;
    var key = origin + '|' + t;
    for (var k in live.topics) {
      if (k === key || k.indexOf(key + '&') === 0) live.topics[k].v++;
    }
  }

  /** Our own write: the next read goes to the network. Bumped when it is sent
   *  AND when it lands, because a timer read that went out in between would
   *  otherwise cache the pre-write reply under the new version — and a phone's
   *  own move never wakes its state channel to correct it. */
  function wrote(p, origin, t) {
    bump(origin, t);
    return p.then(function (r) { bump(origin, t); return r; });
  }

  function topic(origin, t) {
    var key = origin + '|' + t;
    var s = live.topics[key];
    if (s) return s;
    s = live.topics[key] = { ok: false, v: 0, fails: 0 };
    connect(s, origin, t);
    return s;
  }
  function connect(s, origin, t) {
    if (live.noLive[origin] || typeof WebSocket === 'undefined') return;
    var ws, opened = false;
    try { ws = new WebSocket(origin.replace(/^http/, 'ws') + '/api/live?' + t); }
    catch (e) { live.noLive[origin] = true; return; }
    ws.onopen = function () {
      opened = true; s.ok = true; s.fails = 0; s.v++;
      s.ping = setInterval(function () { try { ws.send('ping'); } catch (e) {} }, 25000);
    };
    ws.onmessage = function (e) { if (String(e.data).indexOf('changed') >= 0) s.v++; };
    ws.onclose = function () {
      clearInterval(s.ping);
      s.ok = false; s.v++;
      // Never opened twice running: this service has no live link (the old
      // Vercel one). Stop trying; the page polls as it always did.
      if (!opened) { s.fails++; if (s.fails >= 2) { live.noLive[origin] = true; return; } }
      // A dropped link (wifi, sleep) comes back with backoff: 1, 2, 4 … 30 s.
      s.retry = opened ? 0 : (s.retry || 0) + 1;
      setTimeout(function () { connect(s, origin, t); }, Math.min(30000, 1000 * Math.pow(2, s.retry)));
    };
  }
  function replay(hit) {
    return Promise.resolve(new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.type } }));
  }

  window.fetch = function (input, init) {
    var u = parse(input);
    var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (!u) return F.apply(window, arguments);

    if (method === 'POST' && WRITE.test(u.pathname)) {
      var body = init && init.body;
      var t0 = topicOf(u);
      if (!u.searchParams.get('c') && typeof body === 'string' && body.charAt(0) === '{') {
        try {
          var code = JSON.parse(body).code;
          if (code) {
            u.searchParams.set('c', String(code));
            t0 = 'c=' + String(code).toLowerCase();
            var args = Array.prototype.slice.call(arguments);
            args[0] = u.href;
            return wrote(F.apply(window, args), u.origin, t0);
          }
        } catch (e) {}
      }
      return wrote(F.apply(window, arguments), u.origin, t0);
    }
    if (method !== 'GET' || !READ.test(u.pathname)) return F.apply(window, arguments);

    var t = topicOf(u);
    var keyed = hasKey(init, input);
    // A phone reads the game on the channel that ignores joins and moves.
    if (t && !keyed && /\/api\/game$/.test(u.pathname)) t += '&ch=state';
    var player = named(init, input, 'player');
    var key = u.href + (keyed ? '#k' : '') + (player ? '#p:' + player : '');
    var hit = live.cache[key];
    if (hit && (document.hidden || !seen)) return replay(hit);
    var s = t ? topic(u.origin, t) : null;
    if (hit && s && s.ok && hit.v === s.v) return replay(hit);

    var v = s ? s.v : 0;
    live.net++;
    return F.apply(window, arguments).then(function (r) {
      if (r.ok) {
        r.clone().text().then(function (b) {
          live.cache[key] = { body: b, status: r.status, type: r.headers.get('content-type') || 'application/json', v: v };
        }, function () {});
      }
      return r;
    });
  };
})();
