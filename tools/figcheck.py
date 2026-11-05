#!/usr/bin/env python3
"""Machine layout check for a click-stepped SVG figure page.

Loads the page headless (shoot.py's Chrome driver), walks every state of the
step engine, waits for transitions to settle, and measures what is actually on
screen (computed opacity > 0.5) in viewBox units:

  errors    text overlapping text
            a line/path running through a text label
            text straddling the edge of a rect/circle/shape
            an arrowhead landing on text
            a line crossing a box it neither starts nor ends in
            a mark outside the viewBox
            rendered font-size below 16 viewBox units
            a mark switched on outside the camera frame
            the text font not loaded -- the figure renders in the system font
  warnings  a colour outside the palette (the page's :root custom properties,
            else the theme of --deck; with neither, no palette check;
            --deck's theme colours always join the palette)
            a slide-title-sized heading at the top (the deck's title carries it)
            a fill attribute on text that a CSS class silently overrides (fill-lost)
            final state using < 85% of the frame width or < 75% of its height
            state 0 (what shows on load) already showing stepped marks
            a step that brings marks in and moves nothing (fade-only)
            visible text the deck editor cannot retype: no data-edit="KEY" on
            its node (no-edit), or under a data-edit node that also holds
            child elements (edit-leaf). Skipped: #bar (the step dots and
            hint), data-figcheck="ignore", aria-hidden="true", data-no-edit

    python figcheck.py build/fig.html [--size 1280x500] [--deck deck.html]

Page script errors (uncaught exceptions, console.error) are errors too.
A warning the figure accepts on purpose is declared once in the page, e.g.
<meta name="figcheck-allow" content="state0 coverage">.

Exit 1 on any error. Opt a mark (or a whole group) out with
data-figcheck="ignore". Text inside the same stepped group (`<g class="el">`,
or any `<g data-figcheck="group">`) as a line is not checked against that line.
A figure that moves a camera (a transform on one group) marks that group
data-figcheck="camera", so every mark is measured in the un-zoomed layout.
A colour used on purpose outside the palette (a computed ramp) is declared in
<meta name="figcheck-palette" content="#B5C4E1 #849BCB">. A colour on a straight ramp
between two palette colours (tint -> accent) already passes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deckio  # noqa: E402
import legacy  # noqa: E402
import shoot  # noqa: E402

# the editor's inline retype box (not a label): its class, new and old names
EDIT_BOX = ",".join(".%s-edit-box" % n for n in ("tessera", getattr(legacy, "APP_GLOBAL", "tessera")))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

CHECK_JS = r"""
window.__figcheck = async function (stateNo, isFinal) {
  // ---- let transitions settle (infinite animations, e.g. marching ants, excluded)
  const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await raf();
  const t0 = performance.now();
  await new Promise(r => setTimeout(r, 150));
  while (performance.now() - t0 < 5000) {
    const busy = document.getAnimations().filter(a => a.playState === 'running'
      && isFinite(a.effect && a.effect.getComputedTiming().endTime));
    if (!busy.length) break;
    await new Promise(r => setTimeout(r, 80));
  }

  const svg = document.getElementById('fig') || [...document.querySelectorAll('svg')]
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (!svg) return JSON.stringify({ fatal: 'no <svg> on the page' });
  const vbb = svg.viewBox && svg.viewBox.baseVal;
  const VB = (vbb && vbb.width) ? { x: vbb.x, y: vbb.y, w: vbb.width, h: vbb.height }
                                : { x: 0, y: 0, w: svg.clientWidth, h: svg.clientHeight };
  // A figure with a camera animates a transform on one group, so at a zoomed
  // state half the marks sit outside the viewBox on purpose. Measure in that
  // group's own space instead, which is the layout the author actually wrote.
  const cam = svg.querySelector('[data-figcheck="camera"]');
  const rootInv = (cam || svg).getScreenCTM().inverse();
  const SKIP = 'defs,marker,pattern,clipPath,mask,symbol,linearGradient,radialGradient,'
             + 'filter,title,desc,style,script,foreignObject';
  const all = [...svg.querySelectorAll('*')];
  const order = new Map(all.map((e, k) => [e, k]));
  const issues = [];
  const add = (sev, kind, key, msg, at) => issues.push({ sev, kind, key, msg,
    at: at ? [Math.round(at[0]), Math.round(at[1])] : null });

  const skipped = el => {
    for (let e = el; e && e !== svg; e = e.parentElement) {
      if (e.matches(SKIP)) return true;
      if (e.getAttribute('data-figcheck') === 'ignore') return true;
    }
    return false;
  };
  const opacity = el => {
    let o = 1;
    for (let e = el; e && e !== svg.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none') return 0;
      o *= parseFloat(cs.opacity);
    }
    return getComputedStyle(el).visibility === 'hidden' ? 0 : o;
  };
  const matOf = el => rootInv.multiply(el.getScreenCTM());
  const ap = (M, x, y) => [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f];
  const scaleOf = M => Math.sqrt(Math.abs(M.a * M.d - M.b * M.c));
  const aabb = (M, x0, y0, x1, y1) => {
    const ps = [ap(M, x0, y0), ap(M, x1, y0), ap(M, x0, y1), ap(M, x1, y1)];
    const xs = ps.map(p => p[0]), ys = ps.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const inside = (p, b, pad = 0) => p[0] > b.x0 - pad && p[0] < b.x1 + pad
                                  && p[1] > b.y0 - pad && p[1] < b.y1 + pad;
  const r1 = v => Math.round(v);
  const boxStr = b => `(${r1(b.x0)},${r1(b.y0)})-(${r1(b.x1)},${r1(b.y1)})`;
  const nm = el => {
    if (el.id) return `${el.tagName}#${el.id}`;
    return nmAnon(el);
  };
  // anonymous marks get their paint index in the KEY (not the message), so two
  // "0" tick labels stay two issues
  const K = el => el.id ? '#' + el.id : el.tagName + '@' + order.get(el);
  const nmAnon = el => {
    let a = el.parentElement;
    while (a && a !== svg && !a.id) a = a.parentElement;
    return el.tagName + (a && a !== svg ? ` in #${a.id}` : '');
  };
  const snip = t => {
    const s = (t.textContent || '').trim().replace(/\s+/g, ' ');
    return '"' + (s.length > 22 ? s.slice(0, 21) + '…' : s) + '"';
  };
  // the stepped group a line belongs to: text in it is the line's own label
  const ownGroup = el => {
    for (let e = el.parentElement; e && e !== svg; e = e.parentElement)
      if (e.tagName === 'g' && (e.classList.contains('el')
          || e.getAttribute('data-figcheck') === 'group')) return e;
    return null;
  };

  // ---- visible texts, as INK boxes (cap/ascender top to baseline or descender), one per line
  const texts = [];
  for (const t of svg.querySelectorAll('text')) {
    if (skipped(t) || opacity(t) <= 0.5 || !t.textContent.trim()) continue;
    const M = matOf(t), sc = scaleOf(M);
    const desc = /[gjpqyQ,;()\[\]{}|_@$]/.test(t.textContent);
    const lines = new Map();
    const n = t.getNumberOfChars();
    for (let i = 0; i < n; i++) {
      let ext, pos;
      try { ext = t.getExtentOfChar(i); pos = t.getStartPositionOfChar(i); } catch (e) { continue; }
      if (!(ext.width > 0.01)) continue;
      const k = Math.round(pos.y * 2);
      const L = lines.get(k) || { x0: 1e9, x1: -1e9, top: 1e9, bot: -1e9, base: pos.y };
      L.x0 = Math.min(L.x0, ext.x); L.x1 = Math.max(L.x1, ext.x + ext.width);
      L.top = Math.min(L.top, ext.y); L.bot = Math.max(L.bot, ext.y + ext.height);
      lines.set(k, L);
    }
    const boxes = [...lines.values()].map(L => aabb(M, L.x0 + 0.5,
      L.base - 0.72 * (L.base - L.top), L.x1 - 0.5,
      L.base + (desc ? 0.75 : 0.05) * (L.bot - L.base)));
    if (!boxes.length) continue;
    const u = { x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
                x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) };
    let fs = parseFloat(getComputedStyle(t).fontSize) * sc;
    for (const sp of t.querySelectorAll('tspan'))
      if (sp.textContent.trim()) fs = Math.min(fs, parseFloat(getComputedStyle(sp).fontSize) * sc);
    texts.push({ el: t, boxes, u, fs, name: `${nm(t)} ${snip(t)}` });
  }

  // ---- visible geometry
  const shapes = [];
  // a clip-path on the mark or an ancestor: only the part inside it is drawn
  const clipBox = el => {
    for (let e = el; e && e !== svg; e = e.parentElement) {
      const m = /url\(["']?#([^"')]+)/.exec(getComputedStyle(e).clipPath || '');
      const cp = m && document.getElementById(m[1]);
      if (!cp) continue;
      const Me = matOf(e), bs = [];
      for (const c of cp.children) {
        try { const b = c.getBBox(); bs.push(aabb(Me, b.x, b.y, b.x + b.width, b.y + b.height)); } catch (x) {}
      }
      if (bs.length) return { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)),
                              x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) };
    }
    return null;
  };
  const bgRect =b => (b.x1 - b.x0) >= 0.95 * VB.w && (b.y1 - b.y0) >= 0.9 * VB.h;
  for (const el of svg.querySelectorAll('line,polyline,polygon,path,rect,circle,ellipse')) {
    if (skipped(el)) continue;
    const op = opacity(el);
    if (op <= 0.5) continue;
    const cs = getComputedStyle(el);
    const sw = parseFloat(cs.strokeWidth) || 0;
    const stroke = cs.stroke !== 'none' && sw > 0 && parseFloat(cs.strokeOpacity) > 0.3
                   && !/rgba\(.*,\s*0\)$/.test(cs.stroke);
    const fillNone = cs.fill === 'none' || /rgba\(.*,\s*0\)$/.test(cs.fill);
    const fillA = fillNone ? 0 : parseFloat(cs.fillOpacity);
    const fill = fillA > 0.05;
    if (!stroke && !fill) continue;
    const M = matOf(el), sc = scaleOf(M);
    let bb; try { bb = el.getBBox(); } catch (e) { continue; }
    let box = aabb(M, bb.x, bb.y, bb.x + bb.width, bb.y + bb.height);
    const tag = el.tagName;
    const lineLike = tag === 'line' || (!fill && (tag === 'polyline' || tag === 'path'));
    const open = lineLike && !(tag === 'path' && /z\s*$/i.test(el.getAttribute('d') || ''));
    let L = 0; try { L = el.getTotalLength(); } catch (e) {}
    const clip = clipBox(el);
    if (clip) box = { x0: Math.max(box.x0, clip.x0), y0: Math.max(box.y0, clip.y0),
                      x1: Math.min(box.x1, clip.x1), y1: Math.min(box.y1, clip.y1) };
    const pts = [];
    if (L > 0) {
      const step = 3 / (sc || 1), N = Math.min(4000, Math.ceil(L / step));
      for (let k = 0; k <= N; k++) {
        const s = L * k / N, q = el.getPointAtLength(s), p = ap(M, q.x, q.y);
        if (!clip || inside(p, clip, 0.5)) pts.push({ s, p });
      }
    }
    shapes.push({ el, M, sc, L, pts, box, tag, lineLike, open, sw: sw * sc,
      opaque: fill && fillA * op >= 0.9 && !/^url/.test(cs.fill) && tag !== 'line' && tag !== 'polyline',
      boxy: tag === 'rect' && (stroke || (fill && fillA * op >= 0.9 && !/^url/.test(cs.fill))),
      markers: [cs.markerStart !== 'none' && 0, cs.markerEnd !== 'none' && 1].filter(v => v !== false),
      name: nm(el), group: lineLike ? ownGroup(el) : null, bg: bgRect(box) });
  }
  const occluded = (sh, p) => {
    const me = order.get(sh.el);
    for (const o of shapes) {
      if (!o.opaque || order.get(o.el) <= me || o === sh || !inside(p, o.box)) continue;
      const q = ap(o.M.inverse(), p[0], p[1]);
      try { if (o.el.isPointInFill(new DOMPoint(q[0], q[1]))) return true; } catch (e) {}
    }
    return false;
  };

  // 1. text vs text
  for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
    const A = texts[a], B = texts[b];
    if (A.u.x1 < B.u.x0 || B.u.x1 < A.u.x0 || A.u.y1 < B.u.y0 || B.u.y1 < A.u.y0) continue;
    let hit = null, tight = null;
    const need = 0.12 * Math.max(A.fs, B.fs);   // a 56px number needs ~7 units of air
    for (const p of A.boxes) for (const q of B.boxes) {
      const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (w > 1.5 && h > 1.5) hit = [(Math.max(p.x0, q.x0) + Math.min(p.x1, q.x1)) / 2,
                                   (Math.max(p.y0, q.y0) + Math.min(p.y1, q.y1)) / 2, w, h];
      else if (w > 4 && -h < need) tight = [(Math.max(p.x0, q.x0) + Math.min(p.x1, q.x1)) / 2,
                                          (Math.min(p.y1, q.y1) + Math.max(p.y0, q.y0)) / 2, -h];
    }
    if (hit) add('E', 'text-text', `tt|${K(A.el)}|${K(B.el)}`,
      `${A.name} overlaps ${B.name} by ${r1(hit[2])}x${r1(hit[3])}`, hit);
    else if (tight) add('E', 'text-tight', `tt|${K(A.el)}|${K(B.el)}`,
      `${A.name} and ${B.name} are ${r1(tight[2])} units apart (need ${r1(need)})`, tight);
  }

  // 2. lines / shape edges through text; arrowheads on text
  for (const sh of shapes) {
    const endPad = 6 / (sh.sc || 1);
    for (const T of texts) {
      if (sh.lineLike && sh.group && sh.group.contains(T.el)) continue;
      const u = T.u;
      if (sh.box.x1 < u.x0 || sh.box.x0 > u.x1 || sh.box.y1 < u.y0 || sh.box.y0 > u.y1) continue;
      let n = 0, first = null;
      for (const { s, p } of sh.pts) {
        if (sh.open && (s < endPad || s > sh.L - endPad)) continue;
        if (!T.boxes.some(b => inside(p, b))) continue;
        if (occluded(sh, p)) continue;
        n++; first = first || p;
      }
      if (n >= 2) {
        if (sh.lineLike) add('E', 'line-text', `lt|${K(sh.el)}|${K(T.el)}`,
          `${sh.name} runs through ${T.name} ${boxStr(u)}`, first);
        else add('E', 'edge-text', `et|${K(sh.el)}|${K(T.el)}`,
          `${T.name} straddles the edge of ${sh.name} ${boxStr(sh.box)}`, first);
      }
      for (const m of sh.markers) {
        if (!sh.pts.length) continue;
        const p = sh.pts[m ? sh.pts.length - 1 : 0].p;
        if (T.boxes.some(b => inside(p, b, 3 + sh.sw)))
          add('E', 'arrow-text', `at|${K(sh.el)}|${m}|${K(T.el)}`,
            `arrowhead of ${sh.name} lands on ${T.name}`, p);
      }
    }
  }

  // 3. a line crossing a box it neither starts nor ends in
  for (const sh of shapes) {
    if (!sh.open || sh.pts.length < 2) continue;
    const e0 = sh.pts[0].p, e1 = sh.pts[sh.pts.length - 1].p;
    for (const bx of shapes) {
      if (!bx.boxy || bx.bg || bx === sh) continue;
      const b = bx.box;
      if (b.x1 - b.x0 < 36 || b.y1 - b.y0 < 24) continue;   // cards, not icons
      // a card holds a label; a chart bar or a plot area does not, and a trend
      // line across bars is the point of the chart
      if (!texts.some(T => inside([(T.u.x0 + T.u.x1) / 2, (T.u.y0 + T.u.y1) / 2], b))) continue;
      if (sh.group && sh.group.contains(bx.el)) continue;
      if (inside(e0, b, 6) || inside(e1, b, 6)) continue;
      const inner = { x0: b.x0 + 3, y0: b.y0 + 3, x1: b.x1 - 3, y1: b.y1 - 3 };
      const hits = sh.pts.filter(q => inside(q.p, inner));
      if (hits.length < 2) continue;
      const behind = bx.opaque && order.get(bx.el) > order.get(sh.el);
      // an opaque label pill sitting ON a line is the intended pattern; only
      // card-sized boxes hiding a line count
      if (behind && (b.y1 - b.y0 < 50 || b.x1 - b.x0 < 50)) continue;
      add('E', behind ? 'line-behind-box' : 'line-box', `lb|${K(sh.el)}|${K(bx.el)}`,
        behind ? `${sh.name} is routed behind ${bx.name} ${boxStr(b)}`
               : `${sh.name} cuts through ${bx.name} ${boxStr(b)}`, hits[0].p);
    }
  }

  // 4. outside the viewBox, 5. font floor
  const out = b => b.x0 < VB.x - 1 || b.y0 < VB.y - 1 || b.x1 > VB.x + VB.w + 1 || b.y1 > VB.y + VB.h + 1;
  for (const T of texts) {
    if (out(T.u)) add('E', 'outside', `o|${K(T.el)}`, `${T.name} is outside the viewBox ${boxStr(T.u)}`);
    if (T.fs < 15.95) add('E', 'font', `f|${K(T.el)}`, `${T.name} ${T.fs.toFixed(0)}`);
  }
  for (const sh of shapes)
    if (!sh.bg && out(sh.box)) add('E', 'outside', `o|${K(sh.el)}`, `${sh.name} is outside the viewBox ${boxStr(sh.box)}`);

  // 6. state 0 content, 7. coverage of the final state
  if (stateNo === 0) {
    const on = [...svg.querySelectorAll('.el')].filter(e => !skipped(e) && opacity(e) > 0.5);
    if (on.length) add('W', 'state0', 'state0',
      `state 0 (on load) already shows ${on.length} stepped mark(s): ` +
      on.slice(0, 4).map(nm).join(', ') + (on.length > 4 ? ', …' : ''));
  }
  // 8. material for the cross-state rules the driver applies: where each
  //    visible mark is, whether an off mark will ARRIVE with a direction
  //    (a transform, or a path that draws itself), and what the camera frames.
  //    A transform that happens to be the identity is NOT a direction, so it
  //    does not count — otherwise `translate(0,0)` would satisfy the rule.
  const ident = t => t === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(t)
    || /^matrix3d\(1(,\s*0){3},\s*0,\s*1(,\s*0){3},\s*0,\s*1,\s*0(,\s*0){3},\s*1\)$/.test(t);
  const marks = {}, off = {}, posed = {};
  for (const e of svg.querySelectorAll('.el')) {
    if (skipped(e) || !e.id) continue;
    if (opacity(e) > 0.5) {
      let b; try { b = e.getBBox(); } catch (err) { continue; }
      if (!b.width && !b.height) continue;
      const q = aabb(matOf(e), b.x, b.y, b.x + b.width, b.y + b.height);
      marks[e.id] = [q.x0, q.y0, q.x1, q.y1].map(v => Math.round(v * 2) / 2);
      // a mark the step POSES away from where it was authored travelled to get
      // there, even on the step it enters (the starter's `pose:` field)
      if (e.classList.contains('posed') && !ident(getComputedStyle(e).transform))
        posed[e.id] = true;
    } else {
      const cs = getComputedStyle(e);
      off[e.id] = !ident(cs.transform)
        || Math.abs(parseFloat(cs.strokeDashoffset) || 0) > 0.5;
    }
  }
  const FR = aabb(rootInv.multiply(svg.getScreenCTM()), VB.x, VB.y, VB.x + VB.w, VB.y + VB.h);

  let cover = null;
  if (isFinal) {
    const bs = texts.map(t => t.u).concat(shapes.filter(s => !s.bg).map(s => s.box));
    if (bs.length) {
      const u = { x0: Math.min(...bs.map(b => b.x0)), y0: Math.min(...bs.map(b => b.y0)),
                  x1: Math.max(...bs.map(b => b.x1)), y1: Math.max(...bs.map(b => b.y1)) };
      const cw = (Math.min(u.x1, VB.x + VB.w) - Math.max(u.x0, VB.x)) / VB.w;
      const ch = (Math.min(u.y1, VB.y + VB.h) - Math.max(u.y0, VB.y)) / VB.h;
      cover = [cw, ch];
      if (cw < 0.85 || ch < 0.75) add('W', 'coverage', 'coverage',
        `final state uses ${Math.round(cw * 100)}% of the width and ${Math.round(ch * 100)}% ` +
        `of the height ${boxStr(u)} (want >= 85% / 75%)`);
    }
  }
  return JSON.stringify({ vb: VB, issues, texts: texts.length, shapes: shapes.length,
                          cover, marks, off, posed,
                          frame: [FR.x0, FR.y0, FR.x1, FR.y1] });
};
'go';
"""


# A page with no :root tokens is checked against the deck's own theme (--deck);
# with neither there is nothing to hold its colours to, and the check is skipped.

STYLE_JS = r"""
window.__figstyle = function (extra) {
  const svg = document.getElementById('fig') || [...document.querySelectorAll('svg')]
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const issues = [];
  const add = (sev, kind, key, msg) => issues.push({ sev, kind, key, msg, at: null });
  const hex = c => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '');
    if (!m || (m[4] !== undefined && +m[4] === 0)) return null;
    return '#' + [m[1], m[2], m[3]].map(v => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const norm = v => { const d = document.createElement('i'); d.style.color = v.trim();
    document.body.appendChild(d); const h = hex(getComputedStyle(d).color); d.remove(); return h; };

  // ---- font: the family the text asks for must actually be loaded
  const t0 = svg && svg.querySelector('text');
  if (t0) {
    const fam = getComputedStyle(t0).fontFamily.split(',')[0].trim().replace(/["']/g, '');
    const faces = [...document.fonts].filter(f => f.family.replace(/["']/g, '') === fam);
    const generic = /^(-apple-system|system-ui|sans-serif|serif|monospace|BlinkMacSystemFont|Segoe UI|Roboto|Helvetica|Arial)$/i;
    if (generic.test(fam))
      add('E', 'font-family', 'ff', `text asks for "${fam}" first -- declare the deck font (Manrope) and inline it with embed_font.py`);
    else if (!faces.length)
      add('E', 'font-family', 'ff', `no @font-face for "${fam}" -- it renders in the system font; add the url(MANROPE) rule and build with embed_font.py`);
    else if (!faces.some(f => f.status === 'loaded'))
      add('E', 'font-family', 'ff', `"${fam}" did not load (an un-built source still carrying url(MANROPE)?) -- check the page embed_font.py wrote`);
  }

  // ---- palette
  let allowed = [];
  for (const sh of document.styleSheets) {
    let rules; try { rules = sh.cssRules; } catch (e) { continue; }
    for (const r of rules) if (r.selectorText === ':root')
      for (const p of r.style) if (p.startsWith('--')) {
        const h = norm(r.style.getPropertyValue(p)); if (h) allowed.push(h); }
  }
  const tokens = allowed.length > 0;
  const havePalette = tokens || extra.deck.length > 0;
  allowed.push(...extra.deck, '#FFFFFF', '#000000');
  const meta = document.querySelector('meta[name="figcheck-palette"]');
  if (meta) for (const v of meta.content.split(/[\s,]+/)) { const h = v && norm(v); if (h) allowed.push(h); }
  const ok = new Set(allowed);
  // a ramp computed between two palette colours (tint -> accent, accent -> green) is on-palette
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const pal = [...ok].map(rgb);
  const onRamp = h => {
    const p = rgb(h);
    for (let i = 0; i < pal.length; i++) for (let j = i + 1; j < pal.length; j++) {
      const a = pal[i], b = pal[j], d = b.map((v, k) => v - a[k]);
      const dd = d.reduce((s, v) => s + v * v, 0); if (!dd) continue;
      const t = p.reduce((s, v, k) => s + (v - a[k]) * d[k], 0) / dd;
      if (t <= 0 || t >= 1) continue;
      if (Math.hypot(...p.map((v, k) => v - (a[k] + t * d[k]))) < 6) return true;
    }
    return false;
  };
  const seen = new Map();
  const visible = el => { for (let e = el; e && e !== svg.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e); if (cs.display === 'none' || +cs.opacity === 0) return false; }
    return true; };
  const FILLED = ['text', 'tspan', 'rect', 'circle', 'ellipse', 'path', 'polygon'];
  for (const el of svg.querySelectorAll('*')) {
    if (el.closest('[data-figcheck="ignore"]')) continue;
    const inDefs = !!el.closest('defs');
    if (inDefs && !el.closest('marker,linearGradient,radialGradient')) continue;
    if (!inDefs && !visible(el)) continue;
    const cs = getComputedStyle(el);
    for (const prop of ['fill', 'stroke', 'stop-color']) {
      if (prop === 'stop-color' && el.tagName !== 'stop') continue;
      if (prop === 'fill' && !FILLED.includes(el.tagName)) continue;
      const v = cs.getPropertyValue(prop);
      if (!v || v === 'none' || v.startsWith('url')) continue;
      if (prop === 'stroke' && parseFloat(cs.strokeWidth) === 0) continue;
      const h = hex(v); if (!h || ok.has(h) || onRamp(h)) continue;
      const s = seen.get(h) || { n: 0, ids: new Set() };
      s.n++; const host = el.id ? el : el.closest('[id]'); if (host && host !== svg) s.ids.add(host.id);
      seen.set(h, s);
    }
  }
  if (havePalette) for (const [h, s] of seen)
    add('W', 'palette', 'pal' + h, `${h} is not in the ${tokens ? ':root tokens' : "deck's theme"} (${s.n} mark${s.n > 1 ? 's' : ''}`
      + (s.ids.size ? `, e.g. #${[...s.ids].slice(0, 3).join(', #')}` : '') + ')');

  // ---- a fill ATTRIBUTE that a class silently beats (the text renders in the class colour)
  const lost = [];
  // text only: a state class recolouring a SHAPE (a greyed-out crowd) is deliberate
  for (const el of svg.querySelectorAll('text[fill], tspan[fill]')) {
    const want = norm(el.getAttribute('fill') || '');
    if (!want || el.closest('defs')) continue;
    const got = hex(getComputedStyle(el).fill);
    if (got && got !== want) lost.push((el.id ? '#' + el.id : el.tagName) + ` (${want} drawn as ${got})`);
  }
  if (lost.length)
    add('W', 'fill-lost', 'fill-lost', `fill attribute overridden by a CSS class on ${lost.length} mark(s): `
      + lost.slice(0, 4).join(', ') + ' -- use style="fill:..." or drop the class fill');

  // ---- a slide title drawn inside the figure
  const vb = svg.viewBox.baseVal, inv = svg.getScreenCTM().inverse();
  for (const t of svg.querySelectorAll('text')) {
    const txt = t.textContent.trim();
    if (!/[A-Za-z]{3}.*\s/.test(txt) || !visible(t)) continue;
    const cs = getComputedStyle(t), M = inv.multiply(t.getScreenCTM());
    const size = parseFloat(cs.fontSize) * Math.sqrt(Math.abs(M.a * M.d - M.b * M.c));
    const b = t.getBBox(), top = M.b * b.x + M.d * b.y + M.f;
    if (size >= 28 && +cs.fontWeight >= 700 && top < vb.y + vb.height * 0.1)
      add('W', 'title', 'title', `"${txt.slice(0, 40)}" looks like a slide title -- leave titles to the deck's title element`);
  }
  return JSON.stringify(issues);
};
'go';
"""

# Editable labels (the deck editor's EMBED_TEXT_BRIDGE): every visible text a
# person might want to retype sits on a leaf node carrying data-edit="KEY".
# Run in every state, since a script may write a label only at one step.
EDIT_JS = r"""
window.__figedit = function (EDIT_BOX) {
  const SKIP = 'script,style,noscript,template,title,desc,defs,marker,pattern,clipPath,'
             + 'mask,symbol,linearGradient,radialGradient,filter,textarea,' + EDIT_BOX;
  const out = { missing: [], nested: [] };
  const where = el => {
    const host = el.id ? el : el.closest('[id]');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id
      : host && host !== document.body ? ' in #' + host.id : '');
  };
  const snip = s => { s = s.trim().replace(/\s+/g, ' ');
    return '"' + (s.length > 22 ? s.slice(0, 21) + '…' : s) + '"'; };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.data.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest(SKIP)) continue;
    // the starter's chrome (step dots, "click to advance") is not a label
    if (el.closest('#bar,[data-figcheck="ignore"],[aria-hidden="true"],[data-no-edit]')) continue;
    if (getComputedStyle(el).display === 'none' || el.closest('[hidden]')) continue;
    const ed = el.closest('[data-edit]');
    if (ed === el && !el.children.length) continue;
    // under a data-edit that also holds elements: an override replaces the whole
    // node's text, which wipes its children (a <tspan> second line)
    const key = (ed ? 'nested|' : 'missing|') + where(ed || el) + '|' + n.data.trim();
    (ed ? out.nested : out.missing).push([key, `${where(ed || el)} ${snip(n.data)}`]);
  }
  return JSON.stringify(out);
};
'go';
"""


def deck_colours(deck: Path) -> list[str]:
    """Every hex colour in the deck's theme and its FIGURE STYLE note (the tokens)."""
    text = deck.read_text(encoding="utf-8")
    doc = deckio.read(text)
    src = json.dumps(doc.get("theme", {})) + " ".join(
        n for n in doc.get("agentNotes", []) if isinstance(n, str) and n.startswith("FIGURE STYLE"))
    return sorted({c.upper() for c in re.findall(r"#[0-9A-Fa-f]{6}\b", src)})


def cross_state(per: list[dict], found: dict[str, dict]) -> None:
    """Rules that need two states side by side, not one state on its own.

    off-camera  a mark switched on where the camera is not looking. You added
                something nobody in the room can see.
    fade-only   the step brings marks in, none of them ARRIVES from anywhere,
                nothing already on screen moved, and the camera held still.
                That step is a bullet with extra work: give an entering mark a
                direction, move something that is already there, or move the
                camera. (A mark counts as arriving if its off state carries a
                non-identity transform or a stroke-dashoffset — it travels or
                draws — or if the step poses it away from where it was
                authored.)
    still       the step changes nothing measurable at all: no mark entered or
                left, nothing moved, the camera held. A click that does nothing
                is worse than a fade; usually a `dead`/`sel` re-read the rule
                cannot see, otherwise a step to delete.
    """
    def add(sev, kind, key, k, msg):
        f = found.setdefault(key, {"sev": sev, "kind": kind, "key": key,
                                   "msg": msg, "at": None, "states": []})
        f["states"].append(k)

    def moved(a, b):
        return max(abs(x - y) for x, y in zip(a, b)) > 1.5

    for k in range(1, len(per)):
        prev, cur = per[k - 1], per[k]
        pm, cm = prev.get("marks", {}), cur.get("marks", {})
        entered = [i for i in cm if i not in pm]

        fr = cur.get("frame")
        if fr:
            for i in entered:
                b = cm[i]
                if b[2] < fr[0] or b[0] > fr[2] or b[3] < fr[1] or b[1] > fr[3]:
                    add("E", "off-camera", f"oc|{i}", k,
                        f"#{i} switches on outside the camera frame "
                        f"({_box(b)} vs frame {_box(fr)})")

        stirred = (any(moved(cm[i], pm[i]) for i in cm if i in pm)
                   or (fr and prev.get("frame") and moved(fr, prev["frame"])))

        # a click that changes nothing measurable — no enter, no exit, no motion
        if not entered and not [i for i in pm if i not in cm] and not stirred:
            add("W", "still", f"still|{k}", k,
                "changes nothing measurable — no mark enters or leaves, "
                "nothing moves, the camera holds")
            continue

        # a first state built out of nothing has nothing to move yet
        if not entered or not pm:
            continue
        arrives = prev.get("off", {})
        poses = cur.get("posed", {})
        if any(arrives.get(i) or poses.get(i) for i in entered):
            continue
        if stirred:
            continue
        add("W", "fade-only", f"fade|{k}", k,
            f"brings in {len(entered)} mark(s) — {', '.join(sorted(entered)[:4])}"
            f"{', …' if len(entered) > 4 else ''} — and moves nothing")


def edit_issues(unedit: dict[str, dict[str, tuple[str, int]]], found: dict[str, dict]) -> None:
    """Labels the deck editor cannot retype, one warning per kind.

    no-edit    visible text on a node without data-edit="KEY" (an element whose
               own words are not marked). Mark it, or give text that is not a
               label (a live counter) data-no-edit.
    edit-leaf  text under a data-edit node that also holds child elements: an
               edit replaces the node's whole text and wipes the children (a
               <tspan> second line). Put data-edit on each leaf instead.
    """
    for part, kind, what in (("missing", "no-edit", "without data-edit"),
                             ("nested", "edit-leaf", "under a data-edit that is not a leaf")):
        items = list(unedit[part].values())
        if not items:
            continue
        names = list(dict.fromkeys(name for name, _ in items))
        found[kind] = {"sev": "W", "kind": kind, "key": kind, "at": None,
                       "states": sorted({k for _, k in items}),
                       "msg": f"{len(names)} label(s) {what}: " + ", ".join(names[:4])
                              + (", …" if len(names) > 4 else "")}


def _box(b) -> str:
    return f"({round(b[0])},{round(b[1])})-({round(b[2])},{round(b[3])})"


def goto(cdp, k: int, done: int, w: int, h: int) -> int:
    """Put the figure in state k. Prefer the engine's own go(); else click."""
    if cdp.eval("typeof go === 'function'"):
        cdp.eval(f"go({k})")
        return k
    while done < k:
        shoot.click_frame(cdp, w, h)
        done += 1
        time.sleep(0.4)
    return done


def ranges(ns: list[int]) -> str:
    out, i = [], 0
    while i < len(ns):
        j = i
        while j + 1 < len(ns) and ns[j + 1] == ns[j] + 1:
            j += 1
        out.append(str(ns[i]) if i == j else f"{ns[i]}-{ns[j]}")
        i = j + 1
    return ",".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page")
    ap.add_argument("--size", default="1280x500",
                    help="frame WxH (1280x500 titled embed, 1280x720 full-bleed)")
    ap.add_argument("--settle", type=float, default=0.3)
    ap.add_argument("--deck", help="deck the figure goes into: its theme colours join the palette")
    args = ap.parse_args()
    page = Path(args.page)
    if not page.exists():
        raise SystemExit(f"{page}: not found")
    w, h = (int(v) for v in args.size.lower().split("x"))

    cdp, close = shoot.open_page(page, w, h, 1, args.settle)
    try:
        cdp.call("Runtime.enable")
        for _ in range(40):                 # the page may still be loading
            if cdp.eval("document.readyState === 'complete' && "
                        "!!document.querySelector('svg')"):
                break
            time.sleep(0.25)
        time.sleep(0.3)
        n = shoot.page_states(cdp)
        states = n or 1
        cdp.eval(CHECK_JS)
        cdp.eval(EDIT_JS)
        found: dict[str, dict] = {}
        info = None
        done = 0
        per_state: list[dict] = []
        unedit: dict[str, dict[str, tuple[str, int]]] = {"missing": {}, "nested": {}}
        for k in range(states):
            if k:
                done = goto(cdp, k, done, w, h)
            raw = cdp.eval(f"window.__figcheck({k}, {str(k == states - 1).lower()})")
            res = json.loads(raw or "{}")
            if res.get("fatal"):
                print(f"{page.name}: {res['fatal']}")
                return 1
            info = info or res
            per_state.append(res)
            for it in res["issues"]:
                f = found.setdefault(it["key"], {**it, "states": []})
                f["states"].append(k)
            ed = json.loads(cdp.eval(f"window.__figedit({json.dumps(EDIT_BOX)})") or "{}")
            for part in unedit:
                for key, name in ed.get(part, []):
                    unedit[part].setdefault(key, (name, k))
        cross_state(per_state, found)
        edit_issues(unedit, found)
        # a figure that throws still renders its first state and passes every
        # layout rule; say so loudly, it is the most expensive silent failure
        for i, e in enumerate(dict.fromkeys(cdp.errors)):
            found[f"js{i}"] = {"sev": "E", "kind": "script", "key": f"js{i}",
                               "msg": e, "states": [0]}
        allow = (cdp.eval("(document.querySelector('meta[name=figcheck-allow]')"
                          "||{}).content||''") or "").split()
        cdp.eval(STYLE_JS)
        extra = {"deck": deck_colours(Path(args.deck)) if args.deck else []}
        for it in json.loads(cdp.eval(f"window.__figstyle({json.dumps(extra)})") or "[]"):
            found.setdefault(it["key"], {**it, "states": [states - 1]})
    finally:
        close()

    vb = info["vb"] if info else {}
    head = (f"{page.name}: {states} states ({states - 1} clicks)" if n
            else f"{page.name}: no steps array, 1 state")
    print(f"{head}, viewBox {vb.get('w')}x{vb.get('h')}, frame {w}x{h}")
    # <meta name="figcheck-allow" content="state0 coverage">: warnings the figure
    # accepts on purpose (a timeline visible on load, a figure that is meant to
    # sit centred) stop being re-argued in every handback
    allowed = sorted({f["kind"] for f in found.values()
                      if f["sev"] == "W" and f["kind"] in allow})
    found = {k: f for k, f in found.items()
             if not (f["sev"] == "W" and f["kind"] in allow)}
    errs = [f for f in found.values() if f["sev"] == "E"]
    warns = [f for f in found.values() if f["sev"] == "W"]
    for label, group in (("errors", errs), ("warnings", warns)):
        if not group:
            continue
        print(f"\n{label}:")
        by_first: dict[int, list] = {}
        for f in group:
            by_first.setdefault(f["states"][0], []).append(f)
        for k in sorted(by_first):
            print(f"  state {k}:")
            fonts = [f for f in by_first[k] if f["kind"] == "font"]
            if fonts:                       # one line, not one per label
                msgs: dict[str, int] = {}
                for f in fonts:
                    msgs[f["msg"]] = msgs.get(f["msg"], 0) + 1
                print(f"    {'font < 16':<15} " + "; ".join(
                    m + (f" (x{c})" if c > 1 else "") for m, c in msgs.items()))
            for f in by_first[k]:
                if f["kind"] == "font":
                    continue
                at = f" at {tuple(f['at'])}" if f.get("at") else ""
                also = (f"  [states {ranges(f['states'])}]"
                        if len(f["states"]) > 1 else "")
                print(f"    {f['kind']:<15} {f['msg']}{at}{also}")
    fonts = sum(f["kind"] == "font" for f in errs)
    print(f"\nsummary: {len(errs) - fonts} layout error(s), {fonts} label(s) "
          f"under 16 units, {len(warns)} warning(s)"
          + (" -- clean" if not errs and not warns else "")
          + (f" (allowed by meta: {', '.join(allowed)})" if allowed else ""))
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
