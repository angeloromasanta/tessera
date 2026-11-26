// Appended by serve.py (beside this file) to a deck served at /deck/<slug>,
// by serve.py itself or by an app that mounts it. Keeps the open page in step with the deck file on disk WITHOUT
// reloading: it reads what changed and applies it through the editor's own
// agent interface (window.tessera.agent), the same compare-and-set patches
// slide.py sends to a local editor. So a slide that changes is redrawn in
// place and the viewer stays on the slide they were on.
//
// A full reload is the fallback, used only when a patch cannot express the
// change (something outside the patchable roots) or the editor refuses it.
// A new poll session (every recompile mints one) is the exception: the slides
// are patched and a small notice offers the reload, since only the join code
// on the poll slides is stale.
//
// Two things flow back, so this page edits the deck and is not a copy of it:
//   - a change request typed in the ask box (the editor fires
//     `tessera-request`) is POSTed to /request, which records it through
//     slide.py;
//   - anything else changed here (a slide deleted, added, moved, a text
//     retyped) is POSTed to /edit as the difference between what the page and
//     the deck last agreed on (`base`) and what the page shows now.
// Until the server has taken both, syncing from disk waits, so it cannot undo
// what has not reached the file yet. Where the deck changed first, the deck
// wins: the server refuses that slide and the page shows the deck's again.
(function () {
  var BASE = __BASE__, seen = __VERSION__, rest = __REST__, poll = __POLL__;
  // the editor's names; an older shell's come from tools/legacy.json (put here by serve.py)
  var OLD = __LEGACY__;
  function app() { return window.tessera || window[OLD.api]; }
  var pending = null;       // a new version seen once: synced when it holds still
  var ROOTS = ['slides', 'assets', 'title', 'theme', 'layouts', 'fonts'];
  var MISSING = {};
  var working = false, wait = 0, n = 0;
  var hashes = new Map();   // asset key -> {str, h}: what the editor holds
  var fetched = new Map();  // hash -> string: assets already downloaded
  var outbox = new Map();   // request id -> {slideId, request, tries}: not yet recorded
  var failed = 0;           // until when to show "could not be sent"
  var base = null;          // {title, slides}: what this page and the deck last agreed on (no comments)
  var baseAssets = null;    // the asset keys the deck holds
  var touched = 0;          // when something was last done in this page: it may have edited the deck
  var editWait = 0, editFails = 0;
  var lost = 0;             // until when to show "a change was not kept"

  function strip(doc) {
    return {
      title: doc.title,
      slides: (doc.slides || []).map(function (sl) {
        var c = {};
        Object.keys(sl).forEach(function (k) { if (k !== 'comments') c[k] = sl[k]; });
        return c;
      }),
    };
  }
  function snapshot(doc) {
    base = strip(doc);
    baseAssets = new Set(Object.keys(doc.assets || {}));
  }

  function isIds(v) {
    return Array.isArray(v) && v.every(function (x) {
      return x && typeof x === 'object' && typeof x.id === 'string';
    });
  }
  function eq(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[j]) || !eq(a[ka[j]], b[ka[j]])) return false;
    }
    return true;
  }
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // ID-aware difference -> patches. A port of diff() in html-slides'
  // slide.py, itself a port of the editor's agent-patch.ts.
  function diff(a, b, path, out) {
    if (a !== MISSING && b !== MISSING && eq(a, b)) return;
    if (a !== MISSING && b !== MISSING && isIds(a) && isIds(b)) {
      var ma = new Map(a.map(function (x) { return [x.id, x]; }));
      var mb = new Map(b.map(function (x) { return [x.id, x]; }));
      a.forEach(function (x) {
        diff(x, mb.has(x.id) ? mb.get(x.id) : MISSING, path.concat([{ id: x.id }]), out);
      });
      b.forEach(function (x) {
        if (!ma.has(x.id)) diff(MISSING, x, path.concat([{ id: x.id }]), out);
      });
      var inter = a.filter(function (x) { return mb.has(x.id); }).map(function (x) { return x.id; })
        .concat(b.filter(function (x) { return !ma.has(x.id); }).map(function (x) { return x.id; }));
      var target = b.map(function (x) { return x.id; });
      if (!eq(inter, target)) out.push({ path: path, order: true, before: inter, value: target });
      return;
    }
    if (a !== MISSING && b !== MISSING && a && b && typeof a === 'object' && typeof b === 'object'
        && !Array.isArray(a) && !Array.isArray(b)) {
      Object.keys(a).forEach(function (k) {
        diff(a[k], has(b, k) ? b[k] : MISSING, path.concat([k]), out);
      });
      Object.keys(b).forEach(function (k) {
        if (!has(a, k)) diff(MISSING, b[k], path.concat([k]), out);
      });
      return;
    }
    var p = { path: path };
    if (a !== MISSING) p.before = a;
    if (b !== MISSING) p.value = b;
    out.push(p);
  }

  async function sha1(str) {
    var buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  }
  async function hashOf(key, str) {
    var c = hashes.get(key);
    if (c && c.str === str) return c.h;
    var h = await sha1(str);
    hashes.set(key, { str: str, h: h });
    return h;
  }
  async function get(url, as) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return as === 'text' ? r.text() : r.json();
  }

  // The deck on disk, with every asset the editor already holds left out of
  // the download: the server sends hashes, only changed assets are fetched.
  async function sync(version) {
    var next = await get(BASE + '/doc', 'json');
    if (next.rest !== rest) return 'reload';
    var cur = (await app().agent.read()).doc;
    var curAssets = cur.assets || {}, assets = {};
    for (var key of Object.keys(next.assets)) {
      var h = next.assets[key];
      if (typeof curAssets[key] === 'string' && await hashOf(key, curAssets[key]) === h) {
        assets[key] = curAssets[key];
      } else {
        if (!fetched.has(h)) {
          fetched.set(h, await get(BASE + '/asset?key=' + encodeURIComponent(key) + '&h=' + h, 'text'));
        }
        assets[key] = fetched.get(h);
      }
    }
    Object.assign(assets, next.inline || {});
    next.doc.assets = assets;
    var patches = [];
    ROOTS.forEach(function (root) {
      diff(has(cur, root) ? cur[root] : MISSING, has(next.doc, root) ? next.doc[root] : MISSING, [root], patches);
    });
    window.__deckPreview = { patches: patches.length, at: Date.now() };   // for checking a sync by hand
    if (patches.length) {
      var r = await app().agent.apply({
        id: 'preview-' + Date.now() + '-' + (n++), docId: cur.docId, agent: 'Disk', patches: patches,
      });
      if (r.status === 'busy') return 'busy';   // mid-gesture or presenting: try again shortly
      if (r.status !== 'applied') { console.warn('[deck-preview]', r); return 'reload'; }
      follow(patches);
    }
    if (next.poll !== poll) notice();
    fetched.clear();
    seen = next.version;
    snapshot((await app().agent.read()).doc);
    return 'ok';
  }

  // Following: on a phone (or with ?follow in the address) the page moves to
  // the slide that was just edited, since that is the one being discussed.
  // `?follow=0` turns it off. Needs a deck shell whose agent has goTo().
  var FOLLOW = (function () {
    var q = new URLSearchParams(location.search).get('follow');
    if (q !== null) return q !== '0';
    return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
  })();
  function follow(patches) {
    if (!FOLLOW || typeof app().agent.goTo !== 'function') return;
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i].path;
      if (p[0] === 'slides' && p[1] && typeof p[1].id === 'string') { app().agent.goTo(p[1].id); return; }
    }
  }

  function notice() {
    if (document.getElementById('deck-preview-notice')) return;
    var b = document.createElement('button');
    b.id = 'deck-preview-notice';
    b.textContent = 'The join code changed — tap to reload';
    b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;'
      + 'padding:8px 16px;border:0;border-radius:999px;background:#1A4C9C;color:#fff;'
      + 'font:500 14px/1.3 system-ui,sans-serif;cursor:pointer;opacity:.92';
    b.onclick = function () { location.reload(); };
    document.body.appendChild(b);
  }

  async function deliver() {
    for (var item of Array.from(outbox.values())) {
      if (Date.now() < item.next) continue;
      try {
        if (item.slideId && item.after === undefined) {
          // where the slide sits here: a slide added in this mirror is not in
          // the deck yet, and the server adds it at the same place
          item.after = '';
          try {
            var sl = (await app().agent.read()).doc.slides || [];
            var at = sl.findIndex(function (s) { return s.id === item.slideId; });
            if (at > 0) item.after = sl[at - 1].id;
            item.first = at === 0;
          } catch (err) { /* an older shell: the request goes without it */ }
        }
        var r = await fetch(BASE + '/request', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Key': 'deck-request' },
          body: JSON.stringify({ slideId: item.slideId, request: item.request, after: item.after || '', first: !!item.first }),
        });
        if (r.ok) { outbox.delete(item.request.id); continue; }
        var why = await r.text();
        if (r.status === 400 || r.status === 403 || r.status === 404 || item.tries >= 5) {
          // will not be accepted (or the slide is gone): say so, stop holding the sync
          outbox.delete(item.request.id);
          failed = Date.now() + 10000;
          console.warn('[deck-preview] request not recorded', r.status, why);
          continue;
        }
      } catch (err) { /* offline or the server is restarting: retry */ }
      item.tries++;
      item.next = Date.now() + Math.min(30000, 2000 * item.tries);
    }
    pill();
  }
  function pill() {
    var b = document.getElementById('deck-preview-outbox');
    var unsaved = editFails >= 2;
    var show = outbox.size || unsaved || Date.now() < failed || Date.now() < lost;
    if (show && !b) {
      b = document.createElement('div');
      b.id = 'deck-preview-outbox';
      b.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;'
        + 'padding:6px 14px;border-radius:999px;background:#C8102E;color:#fff;'
        + 'font:500 13px/1.3 system-ui,sans-serif;opacity:.92;pointer-events:none';
      document.body.appendChild(b);
    }
    if (b) {
      if (!show) b.remove();
      else b.textContent = outbox.size ? 'Request not sent yet — retrying'
        : unsaved ? 'Not saved yet — retrying'
        : Date.now() < lost ? 'A change was not kept: the deck changed first'
        : 'A request could not be sent — type it again';
    }
  }

  // What was done here since `base`, written into the deck. Throws to be tried again.
  async function pushEdits() {
    var stamp = touched;
    var cur = (await app().agent.read()).doc;
    var now = strip(cur), patches = [];
    diff(base.slides, now.slides, ['slides'], patches);
    if (typeof now.title === 'string' && now.title !== base.title) {
      var t = { path: ['title'], value: now.title };
      if (base.title !== undefined) t.before = base.title;
      patches.push(t);
    }
    if (!patches.length) { if (touched === stamp) touched = 0; return; }
    // a picture pasted here: the deck does not hold it yet
    var assets = {}, named = JSON.stringify(patches), held = cur.assets || {};
    Object.keys(held).forEach(function (k) {
      if (!baseAssets.has(k) && typeof held[k] === 'string' && named.indexOf(k) >= 0) assets[k] = held[k];
    });
    var r = await fetch(BASE + '/edit', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Key': 'deck-request' },
      body: JSON.stringify({ patches: patches, assets: assets }),
    });
    if (r.status === 409 || r.status >= 500) throw new Error('edit ' + r.status);   // busy or restarting
    var refused = true;
    if (r.ok) {
      refused = ((await r.json()).refused || []).length > 0;
      Object.keys(assets).forEach(function (k) { baseAssets.add(k); });
    } else {
      console.warn('[deck-preview] edit not saved', r.status, await r.text());
    }
    base = now;
    if (touched === stamp) touched = 0;
    if (refused) {
      // not taken (someone changed that slide first, or it cannot be saved):
      // show the deck's version again
      lost = Date.now() + 8000;
      seen = '';
      pending = null;
    }
  }
  function touch() { touched = Date.now(); }
  ['pointerup', 'keyup', 'input', 'change', 'paste', 'cut', 'drop'].forEach(function (name) {
    window.addEventListener(name, touch, true);
  });
  function onRequest(e) {
    var d = e.detail || {};
    // slideId '' = a request about the whole deck (doc.requests)
    if (typeof d.slideId !== 'string' || !d.request || !d.request.id) return;
    outbox.set(d.request.id, { slideId: d.slideId, request: d.request, tries: 0, next: 0 });
    tick();
  }
  // keyed by request id, so a shell that fires both names records it once
  window.addEventListener('tessera-request', onRequest);
  window.addEventListener(OLD.requestEvent, onRequest);

  async function tick() {
    if (working) return;
    working = true;
    try {
      var ready = app() && app().agent && typeof app().agent.read === 'function';
      if (base === null && ready) snapshot((await app().agent.read()).doc);
      if (outbox.size || failed) {
        await deliver();
        if (outbox.size) return;   // a sync now would drop the unsent request
        if (Date.now() >= failed) failed = 0;
      }
      if (touched && base !== null) {
        // wait for the hand to lift, then write what changed; meanwhile a
        // sync from disk would undo it
        if (Date.now() - touched < 700 || Date.now() < editWait) return;
        try {
          await pushEdits();
          editFails = 0;
        } catch (err) {
          editFails++;
          editWait = Date.now() + Math.min(15000, 1500 * editFails);
          pill();
          return;
        }
        pill();
        if (touched) return;
      }
      if (lost && Date.now() >= lost) { lost = 0; pill(); }
      if (Date.now() < wait) return;
      var v = await get(BASE + '/version', 'text');
      // A build writes the file several times (compile, notes, guess slide):
      // sync only once the version holds still for one tick.
      if (v !== seen && v !== pending) { pending = v; return; }
      if (v !== seen) {
        if (!(app() && app().agent && window.crypto && crypto.subtle)) return location.reload();
        var result = await sync(v);
        if (result === 'reload') return location.reload();
        if (result === 'busy') wait = Date.now() + 3000;
      }
    } catch (err) {
      // the file is mid-write, or the server is restarting: the next tick retries
      wait = Date.now() + 2000;
    } finally {
      working = false;
    }
  }
  setInterval(tick, 1000);
})();
