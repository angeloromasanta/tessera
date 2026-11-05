// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Shared model → DOM renderer. One code path draws slides everywhere:
// editor canvas, sidebar thumbnails, and Reveal.js sections.

import type { TesseraDoc, EmbedElement, PollElement, ShapeElement, Slide, SlideElement, SvgElement, TableElement } from './model'
import { isLoopbackUrl, lecturerKey, morphKey, pollHost, pollJoinCode, precedingPoll, ratingScale, ratingStats, tallyChoices } from './model'
import { chartSnapshotSvg } from './charts'
// The renderer is otherwise string-free — the document supplies its own words.
// The one exception is an EDITOR-ONLY prompt for an option the author hasn't
// written yet, which is chrome and never reaches an audience.
import { t } from './i18n'
import temml from 'temml'
import LIVE_SHIM from './live-shim.js?raw'
import GAME_SDK from './game-sdk.js?raw'
import { eitherGlobalJs, frameMsg, GAME_META, LEGACY_NAMES_JS, msgKind } from './legacy'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface RenderOpts {
  /** render svg elements as <img> (cheap DOM) — used by thumbnails */
  svgAsImage?: boolean
  /** hide empty placeholder text entirely — present mode and print */
  hidePlaceholders?: boolean
  /** media (video/audio) accepts pointer input — PRESENT only. On the editor
   *  canvas it stays inert so its native controls don't swallow selection. */
  liveMedia?: boolean
  /** dynamic-field values ({{page}} etc.) for this slide; auto-filled by renderSlide */
  fields?: FieldContext
}

/** Values dynamic field tokens resolve against, computed per slide. */
export interface FieldContext {
  page: number; pages: number; title: string; date: Date
  author: string; company: string; subject: string; event: string
}

/** Field context for a slide: page = 1-based position among non-state slides. */
export function fieldContext(doc: TesseraDoc, slide: Slide): FieldContext {
  const idx = doc.slides.indexOf(slide)
  const upto = idx < 0 ? doc.slides : doc.slides.slice(0, idx + 1)
  const m = doc.meta ?? {}
  return {
    page: upto.filter((s) => !s.stateOf).length,
    pages: doc.slides.filter((s) => !s.stateOf).length,
    title: doc.title,
    date: new Date(),
    author: m.author ?? '',
    company: m.company ?? '',
    subject: m.subject ?? '',
    event: m.event ?? '',
  }
}

const escapeFieldText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Resolve dynamic field tokens in text: {{page}}, {{pages}}, {{title}},
 * {{date}}, {{time}}, plus the document-property fields {{author}}, {{company}},
 * {{subject}}, {{event}}. page/pages take an optional zero-pad width — {{page:2}}
 * → "06". The MODEL stores the raw token; only rendered output is resolved, so
 * inserting/removing slides re-numbers everything and editing doc properties
 * updates every slide automatically. Groundwork for the wider office suite.
 */
export function resolveFields(html: string, ctx?: FieldContext): string {
  if (!ctx || html.indexOf('{{') < 0) return html
  const pad = (n: number, arg?: string) => { const w = parseInt(arg ?? '', 10); return w > 0 ? String(n).padStart(w, '0') : String(n) }
  return html.replace(/\{\{\s*(page|pages|title|date|time|author|company|subject|event)(?::([^}]*))?\s*\}\}/gi, (_m, name: string, arg?: string) => {
    switch (name.toLowerCase()) {
      case 'page': return pad(ctx.page, arg)
      case 'pages': return pad(ctx.pages, arg)
      case 'title': return escapeFieldText(ctx.title)
      case 'date': return escapeFieldText(ctx.date.toLocaleDateString())
      case 'time': return escapeFieldText(ctx.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      case 'author': return escapeFieldText(ctx.author)
      case 'company': return escapeFieldText(ctx.company)
      case 'subject': return escapeFieldText(ctx.subject)
      case 'event': return escapeFieldText(ctx.event)
      default: return ''
    }
  })
}

/** Resolve "asset:<key>" references against the document's asset table. */
export function resolveAsset(doc: TesseraDoc, ref: string): string {
  return ref.startsWith('asset:') ? (doc.assets?.[ref.slice(6)] ?? '') : ref
}

function svgMarkup(el: SvgElement, doc: TesseraDoc): string {
  return (el.asset ? doc.assets?.[el.asset] : el.markup) ?? ''
}

/** The page an embed should load, inline HTML winning over a remote URL. */
function embedMarkup(el: EmbedElement, doc: TesseraDoc, editable = false): string {
  const html = (el.asset ? doc.assets?.[el.asset] : el.html) ?? ''
  return html ? embedPreamble(doc, el, editable, GAME_META.test(html)) + html : ''
}

// A page that opts into the game layer (docs/game.md) with
// <meta name="tessera-game"> gets the SDK (`TesseraGame`, game-sdk.js)
// injected; every other page is untouched (GAME_META, legacy.ts).

/**
 * What an embedded page is told about the deck it is living in — the same
 * courtesy the join page does for an `activity` with `window.TESSERA_ACTIVITY`.
 *
 * It exists for one job: a figure on a late slide that CHARTS what the room
 * answered on an early one. Reading a bucket is an ordinary cross-origin GET
 * (`/api/poll?c=…` answers any origin), so the only thing the page cannot work
 * out for itself is where the service is — its own origin is opaque, and a
 * relative URL would resolve to nothing. Hardcoding the deployment URL into
 * every figure is the alternative, and it breaks the day the service moves.
 *
 * Deliberately not the whole document: an embed is sandboxed away from the
 * deck on purpose, and this is a service address, not a capability. The
 * lecturer key rides along only when the presenter has already entered one, so
 * a figure that needs a locked route can use it without prompting again.
 *
 * `poll.previous` is the nearest poll at or before the embed's own slide. A
 * results figure reads that bucket instead of hard-coding a code, because codes
 * are reminted whenever a deck is made from a template.
 */
function embedPreamble(doc: TesseraDoc, el: EmbedElement, editable = false, game = false): string {
  const info = {
    // the person's own wording for the figure's labels (see EMBED_TEXT_BRIDGE)
    texts: el.texts ?? {},
    editable,
    poll: {
      service: pollHost(doc.poll?.service ? { service: doc.poll.service } : undefined),
      session: doc.poll?.session ?? '',
      lecturer: lecturerKey(),
      previous: embedPoll(doc, el),
    },
  }
  // Every `<` is escaped (the question is audience-facing free text), and
  // `<\/script>` is split so this can never close the tag it is written into.
  const json = JSON.stringify(info).replace(/</g, '\\u003c')
  // The live link (live-shim.js) wraps the page's fetch: figures poll on a
  // timer, and it answers those reads from the last reply while the frame is
  // out of sight and, on a service with /api/live, until the poll changes.
  // October 2026: one figure re-reading a 240-answer bucket every 2.5 s in a
  // forgotten tab cost ~345k Firestore reads an hour.
  // A game page gets its SDK right after the shim, whose fetch it relies on.
  const sdk = game ? `<script>${EMBED_GAME_SDK}<\/script>` : ''
  // The old names come first (legacy-names.js): a figure written before the
  // rename reads the old globals and posts the old message key; both still work.
  return `<script>${EMBED_LEGACY}<\/script><script>window.TESSERA_EMBED=${json}<\/script><script>${EMBED_SHIM}<\/script>${sdk}<script>${EMBED_KEY_BRIDGE}<\/script><script>${EMBED_TEXT_BRIDGE}<\/script>`
}

/**
 * Editable text inside a figure. The frame is sandboxed away from the deck, so
 * the deck cannot reach in; the figure declares its strings instead and this
 * script does the rest. The contract, for any author or agent building a page:
 *
 *   - Mark every visible label with `data-edit="KEY"` on the node that holds
 *     the text itself (an HTML element, an SVG <text> or <tspan>). KEY is
 *     stable across rebuilds of the figure.
 *   - Text a script writes (labels built in JS, canvas drawings) reads
 *     `TESSERA_EMBED.text(KEY, 'default')` instead of a literal.
 *   - Optional: `window.TESSERA_REFIT()` re-measures after a label changes size.
 *
 * Overrides live on the element (`EmbedElement.texts`), never in the page, so
 * a rebuilt figure keeps the person's wording. Overrides are re-applied to
 * `[data-edit]` nodes whenever the page rewrites them. On the edit canvas only,
 * double-clicking a marked node edits it in place; Enter or leaving the field
 * posts `{tessera:'text-changed', key, value}` to the deck, which saves it.
 *
 * The deck changes the texts of a RUNNING figure (undo, redo, another tab, an
 * agent) by posting `{tessera:'set-texts', texts}` instead of rebuilding the
 * frame, which would reload it back to its first step (`sendEmbedTexts`). A
 * removed key gets back the figure's own wording: the node's text from before
 * its first override, or the default the page passed to `TESSERA_EMBED.text()`.
 * Text a script drew from `TESSERA_EMBED.text()` with no marked node showing it
 * (a canvas, a computed string) cannot be redrawn from here, so the reply
 * `{tessera:'texts-applied', stale:true}` asks the deck to reload the frame.
 */
const EMBED_TEXT_BRIDGE = `(function(){
var E = window.TESSERA_EMBED || (window.TESSERA_EMBED = {});
var T = E.texts || (E.texts = {});
var has = function(o, k){ return Object.prototype.hasOwnProperty.call(o, k); };
var own = function(k){ return has(T, k); };
// what a script asked for each key it read, the page's own wording
var dflt = {};
E.text = function(k, fallback){ if (!has(dflt, k)) dflt[k] = fallback; return own(k) ? T[k] : fallback; };
var busy = false;
// a node's own wording from before its first override, to give back on undo
var orig = new WeakMap();
function put(n, v){ if (!orig.has(n)) orig.set(n, n.textContent); n.textContent = v; }
function apply(root){
  if (busy) return;
  var nodes = (root || document).querySelectorAll ? (root || document).querySelectorAll('[data-edit]') : [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], k = n.getAttribute('data-edit');
    if (own(k) && n.textContent !== T[k]) put(n, T[k]);
  }
}
// The deck's texts changed while the figure runs: apply them where it stands.
// Stale (the deck reloads the frame) only when a changed key was read by a
// script and no marked node shows it, or a removed key's node has no wording
// of its own to go back to.
addEventListener('message', function(ev){
  var d = ev.data;
  if (window.parent === window || ev.source !== window.parent || !d || d.tessera !== 'set-texts' || !d.texts || typeof d.texts !== 'object') return;
  var next = d.texts, stale = false, k, i, n, nodes = document.querySelectorAll('[data-edit]');
  function marked(k){ for (var j = 0; j < nodes.length; j++) if (nodes[j].getAttribute('data-edit') === k) return true; return false; }
  busy = true;
  try {
    for (k in T) if (own(k) && !(has(next, k) && typeof next[k] === 'string')) {
      if (has(dflt, k) && !marked(k)) stale = true;
      delete T[k];
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        if (n.getAttribute('data-edit') !== k) continue;
        if (orig.has(n)) { n.textContent = orig.get(n); orig.delete(n); }
        else if (typeof dflt[k] === 'string') n.textContent = dflt[k];
        else stale = true;
      }
    }
    for (k in next) if (has(next, k) && typeof next[k] === 'string' && T[k] !== next[k]) {
      if (has(dflt, k) && !marked(k)) stale = true;
      T[k] = next[k];
    }
  } finally { busy = false; }
  apply(document);
  refit();
  window.parent.postMessage({tessera:'texts-applied', stale: stale}, '*');
});
E.applyTexts = function(){ apply(document); };
var mo = new MutationObserver(function(){ apply(document); });
function start(){
  apply(document);
  mo.observe(document.documentElement, {subtree:true, childList:true, characterData:true});
  if (E.editable && window.parent !== window) editing();
}
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
function refit(){ try { var R = ${eitherGlobalJs('TESSERA_REFIT')}; if (typeof R === 'function') R(); else if (typeof window.refit === 'function') window.refit(); } catch (e) {} }
function editing(){
  var css = document.createElement('style');
  css.textContent = '[data-edit]{cursor:text}[data-edit]:hover{outline:1.5px dashed rgba(91,141,239,.8);outline-offset:2px}' +
    '.tessera-edit-box{position:fixed;z-index:2147483647;box-sizing:border-box;border:2px solid #5b8def;border-radius:4px;background:#fff;color:#1e2a3a;padding:2px 6px;font:inherit;outline:none;min-width:60px}';
  (document.head || document.documentElement).appendChild(css);
  addEventListener('dblclick', function(ev){
    var n = ev.target && ev.target.closest ? ev.target.closest('[data-edit]') : null;
    if (!n) return;
    ev.preventDefault(); ev.stopPropagation();
    begin(n);
  }, true);
}
// Click or double-click? On the edit canvas a click on a label is held for a
// moment: a second click makes it a double-click (edit, and the figure does not
// step); none, and the click is replayed so the figure steps as usual. Clicks
// anywhere else, and every click in the show, go straight through. The replay
// targets the label's parent, so figures that ignore clicks on labels still
// step. Registered at once, in the capture phase on window, so it runs before
// any handler the figure adds.
if (E.editable && window.parent !== window) {
  var held = null;
  addEventListener('click', function(ev){
    if (ev.tesseraReplay) return;
    var n = ev.target && ev.target.closest ? ev.target.closest('[data-edit]') : null;
    if (!n) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    if (held) { clearTimeout(held); held = null; return; }
    var x = ev.clientX, y = ev.clientY, to = n.parentNode || document.body;
    held = setTimeout(function(){
      held = null;
      var e2 = new MouseEvent('click', {bubbles: true, cancelable: true, clientX: x, clientY: y, view: window});
      e2.tesseraReplay = true;
      to.dispatchEvent(e2);
    }, 260);
  }, true);
}
function begin(n){
  var k = n.getAttribute('data-edit'), before = n.textContent;
  var r = n.getBoundingClientRect(), cs = getComputedStyle(n);
  var box = document.createElement('textarea');
  box.className = 'tessera-edit-box';
  box.value = before;
  var size = parseFloat(cs.fontSize) || 16;
  if (n instanceof SVGElement && n.getScreenCTM) { var m = n.getScreenCTM(); if (m) size = size * Math.sqrt(m.a * m.a + m.b * m.b); }
  box.style.font = cs.fontWeight + ' ' + size + 'px ' + cs.fontFamily;
  box.style.left = Math.max(0, r.left - 8) + 'px';
  box.style.top = Math.max(0, r.top - 4) + 'px';
  box.style.width = Math.max(80, r.width + 24) + 'px';
  box.style.height = Math.max(size * 1.5, r.height + 10) + 'px';
  box.rows = 1;
  document.body.appendChild(box);
  box.focus(); box.select();
  var done = false;
  function end(save){
    if (done) return; done = true;
    var v = box.value.replace(/\\s+$/, '');
    box.remove();
    if (!save || v === before) return;
    T[k] = v;
    busy = true;
    var all = document.querySelectorAll('[data-edit]');
    for (var i = 0; i < all.length; i++) if (all[i].getAttribute('data-edit') === k) put(all[i], v);
    busy = false;
    refit();
    window.parent.postMessage({tessera:'text-changed', key:k, value:v}, '*');
  }
  box.addEventListener('keydown', function(e){
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); end(true); }
    if (e.key === 'Escape') { e.preventDefault(); end(false); }
  });
  box.addEventListener('blur', function(){ end(true); });
}
})();`

/** The texts each figure frame's srcdoc was built with: what it shows after a
 *  (re)load, which `sendEmbedTexts` may since have moved on from. */
const builtTexts = new WeakMap<HTMLIFrameElement, string>()
const textsOf = (el: EmbedElement): string => JSON.stringify(el.texts ?? {})

/** Hand a running figure frame its element's current texts, no reload. */
export function sendEmbedTexts(frame: HTMLIFrameElement, el: EmbedElement) {
  // a srcdoc frame's origin is opaque: '*' is the only target that reaches it
  frame.contentWindow?.postMessage(frameMsg('set-texts', { texts: el.texts ?? {} }), '*')
}

/**
 * A slide's look as a key, minus the two things that change without a
 * repaint: its request threads (`comments`), and the texts of its figures
 * (`embed.texts`, handed to running frames instead). `texts` holds those per
 * embed id, `assets` the asset values the slide names (compared by value; a
 * shared string compares in O(1)).
 */
export function slideLook(slide: Slide, doc: TesseraDoc): { sig: string; texts: Map<string, string>; assets: string[] } {
  const texts = new Map<string, string>()
  const sig = JSON.stringify(slide, function (this: unknown, k, v) {
    if (this === slide && k === 'comments') return undefined
    if (k === 'texts' && this && (this as SlideElement).type === 'embed') {
      texts.set((this as EmbedElement).id, JSON.stringify(v ?? {}))
      return undefined
    }
    return v
  })
  const all = doc.assets ?? {}
  const assets = Object.keys(all).filter((k) => sig.includes(k)).map((k) => all[k])
  return { sig, texts, assets }
}

/** Same look apart from figure texts and comments? */
export function sameLook(a: { sig: string; assets: string[] }, b: { sig: string; assets: string[] }): boolean {
  return a.sig === b.sig && a.assets.length === b.assets.length && a.assets.every((x, i) => x === b.assets[i])
}

/**
 * Post the texts that changed between two looks of one slide into the running
 * frames under `root`. A figure showing its poster needs nothing: the poster
 * never carried the texts.
 */
export function postChangedTexts(root: ParentNode, slide: Slide, before: Map<string, string>, after: Map<string, string>) {
  for (const el of slide.elements) {
    if (el.type !== 'embed' || before.get(el.id) === after.get(el.id)) continue
    const frame = root.querySelector<HTMLIFrameElement>(`[data-el-id="${CSS.escape(el.id)}"] > iframe`)
    if (frame) sendEmbedTexts(frame, el)
  }
}

/**
 * The frame half of keeping texts current without reloads, for a surface that
 * shows running figures (the edit canvas, the phone view). `locate` maps a
 * message source to its frame and element, or nothing when the frame is not
 * on that surface.
 *   - `embed-ready`: a frame that (re)loaded shows the texts its srcdoc was
 *     built with; if the element's texts moved on since, send them.
 *   - `texts-applied` with `stale`: the page drew a changed text from script,
 *     so only a reload shows it — `reload(frame)`.
 */
export function watchEmbedTexts(
  locate: (source: MessageEventSource | null) => { frame: HTMLIFrameElement; el: EmbedElement } | undefined,
  reload: (frame: HTMLIFrameElement) => void,
) {
  window.addEventListener('message', (ev) => {
    const d = ev.data
    const kind = msgKind(d)
    if (kind !== 'embed-ready' && kind !== 'texts-applied') return
    const hit = locate(ev.source)
    if (!hit) return
    if (kind === 'texts-applied') { if (d.stale === true) reload(hit.frame); return }
    const built = builtTexts.get(hit.frame)
    if (built !== undefined && built !== textsOf(hit.el)) sendEmbedTexts(hit.frame, hit.el)
  })
}

/** Written into srcdoc HTML, so it must never be able to close its own tag. */
const EMBED_SHIM = LIVE_SHIM.replace(/<\//g, '<\\/')
const EMBED_GAME_SDK = GAME_SDK.replace(/<\//g, '<\\/')
const EMBED_LEGACY = LEGACY_NAMES_JS.replace(/<\//g, '<\\/')

function embedPoll(doc: TesseraDoc, el: EmbedElement): { code: string; kind: string; question: string; join: string } | null {
  let at = doc.slides.findIndex((s) => s.elements.includes(el))
  // A copied element (morph ghosts, re-parsed docs) matches by id and page instead.
  if (at < 0) at = doc.slides.findIndex((s) => s.elements.some((e) => e.type === 'embed' && e.id === el.id && e.asset === el.asset))
  const p = at < 0 ? undefined : precedingPoll(doc, at)
  return p ? { code: p.code, kind: p.kind ?? 'open', question: p.question ?? '', join: pollJoinCode(doc, p) } : null
}

/**
 * The keyboard half of an embed's contract with present mode (the other half
 * is `stepOrNavigate` / `onEmbedMessage` in present.ts).
 *
 * Without it a figure swallowed the show: once the presenter clicked into the
 * frame, arrow keys went to the frame's own document and never reached the
 * deck, so "next slide" meant clicking back outside first. The bridge does two
 * things, both only when the page is actually inside a deck:
 *
 *   - An arrow/PageUp/PageDown/Space the page did NOT `preventDefault()` is
 *     handed up (`embed-key`). A page with no key handling never traps the
 *     show, and a stepped figure lets the key through at either end of its
 *     build — that is how it says "I am finished, move on".
 *   - The deck can OFFER a key it received itself (`deck-key`): it is replayed
 *     into the page as a synthetic keydown, and whether the page consumed it is
 *     reported back (`deck-key-result`). Only pages that set
 *     `window.TESSERA_STEPPED = true` are offered keys (announced in
 *     `embed-ready`) — an older figure wraps from its last step back to its
 *     first and would otherwise hold the deck forever.
 *
 * Keys typed into a field, slider or button stay in the page. Messages carry no
 * capability: the worst a page can do with them is move the show a slide.
 */
const EMBED_KEY_BRIDGE = `(function(){
if (window.parent === window) return;
var P = window.parent, offered = false;
var NAV = {ArrowRight:1, ArrowLeft:1, PageDown:1, PageUp:1, ' ':1};
function field(t){ return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)); }
addEventListener('keydown', function(e){
  if (offered || !NAV[e.key] || e.altKey || e.ctrlKey || e.metaKey || field(e.target)) return;
  setTimeout(function(){ if (!e.defaultPrevented) P.postMessage({tessera:'embed-key', key:e.key}, '*'); }, 0);
});
addEventListener('message', function(ev){
  var d = ev.data;
  if (ev.source !== P || !d || d.tessera !== 'deck-key') return;
  var k = new KeyboardEvent('keydown', {key:d.key, bubbles:true, cancelable:true});
  offered = true;
  try { (document.body || document.documentElement).dispatchEvent(k); } finally { offered = false; }
  P.postMessage({tessera:'deck-key-result', id:d.id, handled:k.defaultPrevented}, '*');
});
function ready(){ P.postMessage({tessera:'embed-ready', stepped: !!${eitherGlobalJs('TESSERA_STEPPED')}}, '*'); }
if (document.readyState === 'complete') ready(); else addEventListener('load', ready);
})();`

/**
 * True when this embed will load a THIRD-PARTY http(s) URL — `src` pointing at
 * an origin that is not the document's own.
 *
 * `asset`/`html` embeds are excluded because they render through `srcdoc`, and
 * a srcdoc frame inherits the parent's origin: `allow-same-origin` there would
 * literally hand the frame this document. A relative or same-origin `src` is
 * excluded for the same reason. Anything that is not http(s) — `data:`,
 * `blob:`, a malformed URL — is excluded too; those get an opaque origin no
 * matter what the attribute says, so asking for one buys nothing and only
 * widens what has to be reasoned about.
 */
function embedIsThirdParty(el: EmbedElement): boolean {
  if (el.asset || el.html || !el.src) return false
  try {
    const url = new URL(el.src, location.href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return url.origin !== location.origin
  } catch {
    return false
  }
}

/**
 * Sandbox tokens for an embed. `allow-scripts` is the baseline — an embed that
 * cannot run JS is just a slow image.
 *
 * `allow-same-origin` is the one token that is not simply passed through. In a
 * sandbox it does not mean "same origin as the parent"; it means "keep your
 * OWN origin instead of an opaque one". For an inline page that origin IS the
 * parent's, so granting it would give the frame this document — which carries
 * the deck's E2EE room keys. For a frame loading a third-party URL the origin
 * is that third party's, and the frame still cannot touch the parent.
 *
 * So it is honoured only when the element explicitly asks for it AND the frame
 * is loading a cross-origin http(s) `src` ({@link embedIsThirdParty}). That is
 * what a hosted player needs to boot — YouTube, Vimeo, a Google Slides embed
 * all render a blank rectangle under an opaque origin. Inline pages, relative
 * URLs and same-origin URLs are refused exactly as before.
 */
export function embedSandbox(el: EmbedElement): string {
  const asked = el.sandbox ?? []
  const extra = asked.filter(t => t !== 'allow-same-origin')
  if (asked.includes('allow-same-origin') && embedIsThirdParty(el)) {
    extra.push('allow-same-origin')
  }
  return ['allow-scripts', ...extra].join(' ')
}

/**
 * Scope injected svg CSS to one element instance. svg <style> applies
 * document-wide, so unscoped rules from one diagram would leak into every
 * other svg on the page (including other slides' copies of the same asset).
 * @keyframes blocks stay top-level; everything else gets the scope prefix.
 */
export function scopeCss(css: string, scope: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const rest = css.slice(i)
    const at = rest.match(/^\s*@(keyframes|-webkit-keyframes)/)
    if (at) {
      // copy the whole block verbatim, tracking brace depth
      let depth = 0
      let j = i
      let seen = false
      while (j < css.length) {
        if (css[j] === '{') { depth++; seen = true }
        if (css[j] === '}') { depth--; if (seen && depth === 0) { j++; break } }
        j++
      }
      out += css.slice(i, j) + '\n'
      i = j
      continue
    }
    const open = css.indexOf('{', i)
    if (open === -1) break
    const close = css.indexOf('}', open)
    if (close === -1) break
    const selectors = css.slice(i, open).trim()
    if (selectors) {
      out += selectors.split(',').map((s) => `${scope} ${s.trim()}`).join(', ')
      out += ' ' + css.slice(open, close + 1) + '\n'
    }
    i = close + 1
  }
  return out
}

export function applyElementFrame(node: HTMLElement, el: SlideElement) {
  node.style.left = `${el.x}px`
  node.style.top = `${el.y}px`
  node.style.width = `${el.w}px`
  node.style.height = `${el.h}px`
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : ''
  node.style.opacity = String(el.opacity)
  const shadows = Array.isArray(el.shadow) ? el.shadow : el.shadow ? [el.shadow] : []
  const parts = shadows.map((s) => `drop-shadow(${s.x ?? 0}px ${s.y ?? 0}px ${s.blur}px ${s.color})`)
  if (el.blur) parts.push(`blur(${el.blur}px)`)
  node.style.filter = parts.length ? parts.join(' ') : ''
  node.style.mixBlendMode = el.blend || ''
  if (el.backdropFilter) {
    const bf = `blur(${el.backdropFilter}px)`
    node.style.backdropFilter = bf
    node.style.setProperty('-webkit-backdrop-filter', bf)
  } else {
    node.style.backdropFilter = ''
  }
}

// Gradient ids must be unique per rendered instance: the same element renders
// on the canvas, in sidebar thumbnails and in the present overlay, and svg
// url(#…) references resolve document-wide.
let gradSeq = 0

/** Gradient line endpoints (objectBoundingBox units) for a CSS-convention
 *  angle: 0deg points up, 90deg points right. Shared with morph tweening. */
export function gradientLineCoords(angle: number) {
  const rad = ((angle ?? 180) * Math.PI) / 180
  const dx = Math.sin(rad) / 2
  const dy = -Math.cos(rad) / 2
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy }
}

/** CSS linear-gradient() from a GradientFill. CSS angle convention matches the
 *  model (0deg = bottom->top, 90deg = left->right), so pass angle straight. */
export function cssLinearGradient(g: NonNullable<ShapeElement['fillGradient']>): string {
  const stops = g.stops
    .map((s) => `${s.color} ${Math.round(Math.min(Math.max(s.at, 0), 1) * 100)}%`)
    .join(', ')
  return `linear-gradient(${g.angle}deg, ${stops})`
}

/** Materialize a GradientFill as a <defs> gradient; returns its url() ref. */
function gradientRef(svg: SVGSVGElement, g: NonNullable<ShapeElement['fillGradient']>): string {
  const id = `tessera-grad-${gradSeq++}`
  const defs = document.createElementNS(SVG_NS, 'defs')
  const lin = document.createElementNS(SVG_NS, 'linearGradient')
  lin.setAttribute('id', id)
  const { x1, y1, x2, y2 } = gradientLineCoords(g.angle)
  lin.setAttribute('x1', String(x1))
  lin.setAttribute('y1', String(y1))
  lin.setAttribute('x2', String(x2))
  lin.setAttribute('y2', String(y2))
  for (const s of g.stops) {
    const stop = document.createElementNS(SVG_NS, 'stop')
    stop.setAttribute('offset', String(Math.min(Math.max(s.at, 0), 1)))
    stop.setAttribute('stop-color', s.color)
    lin.appendChild(stop)
  }
  defs.appendChild(lin)
  svg.appendChild(defs)
  return `url(#${id})`
}

/** stroke-dasharray for the element's line style (undefined = solid). */
function dashArray(el: ShapeElement, w: number): string | undefined {
  if (el.strokeStyle === 'dashed') return `${Math.max(w * 2.4, 7)} ${Math.max(w * 1.8, 5)}`
  if (el.strokeStyle === 'dotted') return `0.1 ${Math.max(w * 2.2, 5)}`
  if (el.strokeStyle === 'solid') return undefined
  if (el.strokeDash) return `${el.strokeDash} ${el.strokeDash}` // legacy numeric dash
  return undefined
}

let markSeq = 0

/** A line-tip marker in <defs>; sized in strokeWidth units, colored like the line. */
function markerRef(svg: SVGSVGElement, kind: NonNullable<ShapeElement['lineStart']>, color: string, start: boolean): string | null {
  if (kind === 'none') return null
  const id = `tessera-mark-${markSeq++}`
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refY', '4')
  marker.setAttribute('orient', start ? 'auto-start-reverse' : 'auto')
  marker.setAttribute('markerWidth', '5.5')
  marker.setAttribute('markerHeight', '5.5')
  let tip: SVGElement
  if (kind === 'arrow') {
    tip = document.createElementNS(SVG_NS, 'path')
    tip.setAttribute('d', 'M 0 0.4 L 7.6 4 L 0 7.6 Z')
    marker.setAttribute('refX', '6.4')
  } else if (kind === 'dot') {
    tip = document.createElementNS(SVG_NS, 'circle')
    tip.setAttribute('cx', '4')
    tip.setAttribute('cy', '4')
    tip.setAttribute('r', '2.6')
    marker.setAttribute('refX', '4')
  } else {
    tip = document.createElementNS(SVG_NS, 'rect')
    tip.setAttribute('x', '3.2')
    tip.setAttribute('y', '0.4')
    tip.setAttribute('width', '1.6')
    tip.setAttribute('height', '7.2')
    marker.setAttribute('refX', '4')
  }
  tip.setAttribute('fill', color)
  marker.appendChild(tip)
  let defs = svg.querySelector('defs')
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs')
    svg.appendChild(defs)
  }
  defs.appendChild(marker)
  return `url(#${id})`
}

export function shapeSvg(el: ShapeElement): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const { w, h } = el
  const sw = el.strokeWidth
  const inset = sw / 2
  svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'

  let node: SVGElement
  switch (el.shape) {
    case 'path': {
      // arbitrary vector data, stretched from its authored viewBox into the box
      if (el.pathBox) svg.setAttribute('viewBox', el.pathBox.join(' '))
      node = document.createElementNS(SVG_NS, 'path')
      node.setAttribute('d', el.d ?? '')
      if (sw > 0) node.setAttribute('vector-effect', 'non-scaling-stroke')
      break
    }
    case 'rect': {
      node = document.createElementNS(SVG_NS, 'rect')
      node.setAttribute('x', String(inset))
      node.setAttribute('y', String(inset))
      node.setAttribute('width', String(Math.max(w - sw, 0)))
      node.setAttribute('height', String(Math.max(h - sw, 0)))
      if (el.radius) node.setAttribute('rx', String(el.radius))
      break
    }
    case 'ellipse': {
      node = document.createElementNS(SVG_NS, 'ellipse')
      node.setAttribute('cx', String(w / 2))
      node.setAttribute('cy', String(h / 2))
      node.setAttribute('rx', String(Math.max(w / 2 - inset, 0)))
      node.setAttribute('ry', String(Math.max(h / 2 - inset, 0)))
      break
    }
    case 'triangle': {
      node = document.createElementNS(SVG_NS, 'polygon')
      node.setAttribute('points', `${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`)
      break
    }
    case 'arrow': {
      // right-pointing arrow: shaft + head, proportional to the box
      node = document.createElementNS(SVG_NS, 'polygon')
      const shaftH = h * 0.44
      const headW = Math.min(w * 0.38, h)
      const y0 = (h - shaftH) / 2
      node.setAttribute(
        'points',
        `0,${y0} ${w - headW},${y0} ${w - headW},0 ${w},${h / 2} ${w - headW},${h} ${w - headW},${y0 + shaftH} 0,${y0 + shaftH}`,
      )
      break
    }
    case 'line': {
      node = document.createElementNS(SVG_NS, 'line')
      const lw = Math.max(sw, 2)
      // inset the endpoints so tip decorations sit inside the element box
      const tipPad = (k?: string) => (k && k !== 'none' ? lw * 2.6 : 0)
      node.setAttribute('x1', String(tipPad(el.lineStart)))
      node.setAttribute('y1', String(h / 2))
      node.setAttribute('x2', String(w - tipPad(el.lineEnd)))
      node.setAttribute('y2', String(h / 2))
      node.setAttribute('stroke', el.fill)
      node.setAttribute('stroke-width', String(lw))
      node.setAttribute('stroke-linecap', el.strokeStyle === 'dashed' ? 'butt' : 'round')
      const lineDash = dashArray(el, lw)
      if (lineDash) node.setAttribute('stroke-dasharray', lineDash)
      const mStart = el.lineStart ? markerRef(svg, el.lineStart, el.fill, true) : null
      const mEnd = el.lineEnd ? markerRef(svg, el.lineEnd, el.fill, false) : null
      if (mStart) node.setAttribute('marker-start', mStart)
      if (mEnd) node.setAttribute('marker-end', mEnd)
      svg.appendChild(node)
      return svg
    }
  }
  node.setAttribute('fill', el.fillGradient?.stops.length ? gradientRef(svg, el.fillGradient) : el.fill)
  if (el.stroke && el.stroke !== 'transparent' && sw > 0) {
    node.setAttribute('stroke', el.stroke)
    node.setAttribute('stroke-width', String(sw))
    const dash = dashArray(el, sw)
    if (dash) node.setAttribute('stroke-dasharray', dash)
    if (el.strokeStyle === 'dotted') node.setAttribute('stroke-linecap', 'round')
  }
  svg.appendChild(node)
  return svg
}

// --- math ($…$ → MathML) -----------------------------------------------------

/**
 * LaTeX math in text, resolved at RENDER time — the same trick resolveFields
 * uses for {{page}}. The MODEL stores the raw source (`$E=mc^2$`), so the
 * format gains nothing to version: an older build opening a newer file shows
 * the literal `$E=mc^2$` — degraded, legible, and nothing is lost.
 *
 * MathML, not HTML+CSS, is what makes this affordable. Temml emits MathML and
 * the browser lays it out with its own math fonts; KaTeX would have to ship a
 * layout engine AND ~20 webfont faces (measured: +421KB against Temml's +64KB).
 *
 * MUST run AFTER sanitizeHtml, never before: the sanitizer unwraps every tag
 * outside its allowlist and strips all attributes, so it would demolish the
 * MathML. Running after is also why the allowlist needs no widening — this
 * markup is GENERATED by us from LaTeX source, never accepted from the author.
 * Temml runs with trust off, so \href and friends are inert.
 */
const mathCache = new Map<string, string>()

/** Undo the entity escaping sanitizeHtml applied, so `x &lt; y` reaches TeX as `x < y`. */
function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  const ta = document.createElement('textarea')
  ta.innerHTML = s
  return ta.value
}

/**
 * Tag each MathML token with a key that identifies "the same symbol" across
 * two slides, so present.ts can morph a formula symbol by symbol instead of
 * crossfading it — a term crossing the equals sign visibly travels there.
 *
 * The key is the token's own text plus its occurrence index (`x#0`, `x#1`),
 * which is what makes rearrangement work: the second `x` in one formula pairs
 * with the second `x` in the next, wherever each has moved to. Purely a
 * RENDER-time attribute — nothing about it enters the document.
 */
function tagSymbols(mathml: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = mathml
  const seen = new Map<string, number>()
  for (const leaf of Array.from(tpl.content.querySelectorAll('mi, mn, mo'))) {
    const txt = (leaf.textContent ?? '').trim()
    if (!txt) continue
    const n = seen.get(txt) ?? 0
    seen.set(txt, n + 1)
    ;(leaf as HTMLElement).dataset.sym = `${txt}#${n}`
  }
  return tpl.innerHTML
}

function renderMath(src: string, display: boolean): string | null {
  const key = (display ? 'D' : 'I') + src
  const hit = mathCache.get(key)
  if (hit !== undefined) return hit || null
  let out: string | null = null
  try {
    out = tagSymbols(
      temml.renderToString(decodeEntities(src), { displayMode: display, throwOnError: true, trust: false }),
    )
  } catch {
    out = null // not valid TeX — leave the author's text exactly as typed
  }
  mathCache.set(key, out ?? '')
  return out
}

export function resolveMath(html: string): string {
  if (html.indexOf('$') < 0) return html
  // $$…$$ first (display), then $…$ (inline). The inline form is deliberately
  // fussy so ordinary prose survives: no whitespace just inside the delimiters
  // and no digit straight after the closer, which is what keeps "it costs $5
  // and $10" from parsing as math. A backslash-escaped \$ is a literal dollar.
  let out = html.replace(/(^|[^\\])\$\$([^$]+?)\$\$/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, true)
    return ml ? pre + ml : m
  })
  out = out.replace(/(^|[^\\$])\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (m, pre: string, src: string) => {
    const ml = renderMath(src, false)
    return ml ? pre + ml : m
  })
  return out.replace(/\\\$/g, '$') // the escape has done its job
}

const ALLOWED_TAGS = new Set(['B', 'I', 'U', 'BR', 'SPAN', 'DIV', 'P', 'STRONG', 'EM', 'S', 'CODE', 'MARK', 'A'])

/** Keep pasted/edited rich text down to a safe inline subset. */
export function sanitizeHtml(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const elChild = child as HTMLElement
        if (!ALLOWED_TAGS.has(elChild.tagName)) {
          walk(elChild)
          // unwrap unknown elements, keep their text
          while (elChild.firstChild) node.insertBefore(elChild.firstChild, elChild)
          elChild.remove()
          continue
        }
        const href = elChild.tagName === 'A' ? elChild.getAttribute('href') : null
        for (const attr of Array.from(elChild.attributes)) elChild.removeAttribute(attr.name)
        if (href && /^https?:\/\//i.test(href.trim())) {
          try {
            const url = new URL(href.trim())
            if (url.protocol === 'http:' || url.protocol === 'https:') {
              elChild.setAttribute('href', url.href)
              elChild.setAttribute('target', '_blank')
              elChild.setAttribute('rel', 'noopener noreferrer')
            }
          } catch { /* Invalid links retain their visible label only. */ }
        }
        walk(elChild)
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove()
      }
    }
  }
  walk(tpl.content)
  const out = document.createElement('div')
  out.appendChild(tpl.content.cloneNode(true))
  return out.innerHTML
}

/**
 * Lists inside ONE text element. A line that begins `- `, `• ` or `– ` draws as
 * a bullet: an accent-coloured marker hanging in the margin, the text wrapping
 * under itself rather than under the marker, and a little air between items.
 * Two or more leading spaces (or `&nbsp;`s) make it a second-level item.
 *
 * It replaces the old recipe of one text box per bullet plus one box per dot,
 * which could not be edited as a list and whose spacing broke whenever a line
 * wrapped differently from the estimate that placed the next box. The stored
 * `html` stays plain — `• point<br>• point` — so the author edits text, never
 * list markup (canvas.ts restores the raw html when editing starts). Only the
 * rendering is structural. Lines are `<br>`-separated or block `div`/`p`s
 * (what contentEditable makes on Enter). Text with no list line is untouched.
 */
const LIST_LINE = /^([  ]*)[-•–][  ]+/
function layoutListLines(inner: HTMLElement, accent: string): void {
  const lines: Node[][] = [[]]
  const walk = (parent: Node) => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeName === 'BR') {
        // a block's trailing <br> is contentEditable's placeholder, not a line
        if (parent !== inner && n === parent.lastChild) continue
        lines.push([])
      } else if (n.nodeName === 'DIV' || n.nodeName === 'P') {
        if (lines[lines.length - 1].length) lines.push([])
        walk(n)
        lines.push([])
      } else {
        lines[lines.length - 1].push(n)
      }
    }
  }
  walk(inner)
  while (lines.length && !lines[lines.length - 1].length) lines.pop()
  const textOf = (ns: Node[]) => ns.map((n) => n.textContent ?? '').join('')
  const hasList = lines.some((ns) => LIST_LINE.test(textOf(ns)))
  if (!hasList && !lines.some((ns) => codeLine(ns))) return
  const rows = lines.map((ns, i) => {
    const row = document.createElement('div')
    const m = textOf(ns).match(LIST_LINE)
    const code = m ? null : codeLine(ns)
    for (const n of ns) row.appendChild(n)
    if (!ns.length) row.appendChild(document.createElement('br'))
    if (code) {
      // a code block: aligned with the bullet text of its level (two leading
      // spaces = under a sub-point), flush left in a box with no list
      for (const n of ns) if (n !== code.el) (n as ChildNode).remove()
      const level = code.lead >= 2 ? 2 : hasList ? 1 : 0
      row.style.paddingLeft = `${1.1 * level}em`
      row.dataset.code = '1'
      code.el.style.cssText = codeBlockCss(accent)
      if (i > 0) row.style.marginTop = '0.45em'
      return row
    }
    if (!m) return row
    stripLeadingChars(row, m[0].length)
    const level = m[1].length >= 2 ? 2 : 1
    const indent = 1.1 * level
    row.style.position = 'relative'
    row.style.paddingLeft = `${indent}em`
    if (i > 0) row.style.marginTop = '0.4em'
    const mark = document.createElement('span')
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = level === 1 ? '•' : '–'
    mark.style.cssText = `position:absolute;left:${(indent - 1.05).toFixed(2)}em;top:0;color:${accent};font-weight:700`
    row.prepend(mark)
    return row
  })
  // consecutive code lines at one indent read as ONE block: square the joins
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]
    if (!a.dataset.code || !b.dataset.code || a.style.paddingLeft !== b.style.paddingLeft) continue
    const ca = a.firstElementChild as HTMLElement, cb = b.firstElementChild as HTMLElement
    ca.style.borderBottomLeftRadius = ca.style.borderBottomRightRadius = '0'
    ca.style.paddingBottom = '0.1em'
    cb.style.borderTopLeftRadius = cb.style.borderTopRightRadius = '0'
    cb.style.paddingTop = '0.1em'
    b.style.marginTop = '0'
  }
  inner.replaceChildren(...rows)
  if (hasList) inner.dataset.list = '1'
}

/**
 * A line that holds nothing but one `<code>` span (leading spaces allowed) is a
 * code block, not inline code. Typing `x` in the editor already makes the span,
 * so a block is simply a line of code on its own; several in a row join up.
 */
function codeLine(ns: Node[]): { el: HTMLElement; lead: number } | null {
  let el: HTMLElement | null = null
  let lead = 0
  for (const n of ns) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? ''
      if (t.trim()) return null
      if (!el) lead += t.length
    } else if (n.nodeName === 'CODE' && !el) {
      el = n as HTMLElement
    } else {
      return null
    }
  }
  return el && el.textContent?.trim() ? { el, lead } : null
}

function codeBlockCss(accent: string): string {
  return 'display:block;white-space:pre-wrap;word-break:break-word;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
    'font-size:0.7em;line-height:1.55;padding:0.6em 1em;border-radius:6px;' +
    'background:color-mix(in srgb, currentColor 6%, transparent);' +
    `border:0;border-left:3px solid ${accent};`
}

/** Delete the first `count` characters of a subtree's text, across nodes. */
function stripLeadingChars(root: Node, count: number): void {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let t: Text | null
  while (count > 0 && (t = tw.nextNode() as Text | null)) {
    const k = Math.min(count, t.data.length)
    t.deleteData(0, k)
    count -= k
  }
}

const VALIGN: Record<string, string> = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/**
 * Chips inside table cells, styled inline so print and thumbnails match:
 * `<code>` is a command chip, `<mark>` a soft tag in the accent, and
 * `<mark><b>…</b></mark>` the same tag filled. The input is sanitizer output,
 * so these tags carry no attributes and match exactly.
 */
function cellChips(html: string, accent: string): string {
  if (html.indexOf('<code>') < 0 && html.indexOf('<mark>') < 0) return html
  const tag = 'display:inline-block;padding:0.12em 0.6em;border-radius:4px;' +
    'font-size:0.8em;font-weight:600;line-height:1.45;'
  return html
    .replace(/<mark>(?=\s*<(?:b|strong)>)/g,
      `<mark style="${tag}background:${accent};color:#FFFFFF;">`)
    .replace(/<mark>/g,
      `<mark style="${tag}background:color-mix(in srgb, ${accent} 12%, #FFFFFF);color:${accent};">`)
    .replace(/<code>/g,
      '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
      'font-size:0.88em;padding:0.14em 0.45em;border-radius:4px;' +
      'background:color-mix(in srgb, currentColor 7%, transparent);' +
      'border:1px solid color-mix(in srgb, currentColor 14%, transparent);">')
}

/**
 * Render a table element as a real HTML <table> string (table-layout: fixed).
 * Column widths are fractional weights normalised to %. Cells carry data-r /
 * data-c so the editor can target them for in-cell editing.
 */
export function renderTableHtml(el: TableElement, doc: TesseraDoc): string {
  const st = el.style
  const esc = (s: string) => s.replace(/"/g, '&quot;')
  const totalW = el.columns.reduce((s, c) => s + (c.w || 0), 0) || 1
  const cols = el.columns
    .map((c) => `<col style="width:${(((c.w || 0) / totalW) * 100).toFixed(4)}%">`)
    .join('')
  const font = esc(st.fontFamily || doc.theme.fontFamily)
  const line = st.borderWidth ? `${st.borderWidth}px solid ${st.borderColor}` : ''
  const rowsOnly = st.rules === 'rows'
  const last = el.rows.length - 1
  const rowsHtml = el.rows
    .map((row, r) => {
      const isHeader = el.header && r === 0
      const bodyIndex = el.header ? r - 1 : r
      const stripe = !isHeader && st.zebra && bodyIndex % 2 === 1 ? st.zebra : ''
      // `rows`: one hairline between rows and nothing else. `grid`: every
      // cell boxed. Either way a headerRule replaces the line under row 0.
      const under = isHeader && st.headerRule ? `2px solid ${st.headerRule}`
        : rowsOnly ? (r < last ? line : '') : ''
      const border = rowsOnly
        ? `border:0;${under ? `border-bottom:${under};` : ''}`
        : (line ? `border:${line};` : '') + (under ? `border-bottom:${under};` : '')
      const caps = isHeader && st.headerCaps
        ? 'text-transform:uppercase;letter-spacing:0.08em;font-size:0.78em;' : ''
      const cells = row.cells
        .map((cell, c) => {
          const align = cell.align || 'left'
          const bg = cell.bg || (isHeader ? st.headerBg : stripe || 'transparent')
          const color = cell.color || (isHeader ? st.headerColor : st.color)
          const weight = isHeader ? (st.headerCaps ? 600 : 700) : cell.bold ? 700 : 400
          return (
            `<td data-r="${r}" data-c="${c}" style="${border}padding:${st.cellPadY}px ${st.cellPadX}px;` +
            `text-align:${align};vertical-align:middle;color:${color};background:${bg};${caps}` +
            `font-weight:${weight};overflow:hidden;word-break:break-word;">` +
            // dir="auto" per cell for the same reason text elements carry it:
            // a table of Arabic terms is otherwise laid out as if it were
            // English. Per cell, so a bilingual table stays correct in both
            // columns.
            `<div class="tessera-cell-inner" dir="auto">${cellChips(sanitizeHtml(cell.html || ''), doc.theme.accent) || '<br>'}</div></td>`
          )
        })
        .join('')
      return `<tr data-r="${r}">${cells}</tr>`
    })
    .join('')
  const radius = st.radius ? `border-radius:${st.radius}px;overflow:hidden;` : ''
  return (
    `<div class="tessera-table-wrap" style="width:100%;height:100%;${radius}">` +
    `<table class="tessera-table" style="width:100%;height:100%;border-collapse:collapse;` +
    `table-layout:fixed;font-family:${font};font-size:${st.fontSize}px;line-height:1.3;">` +
    `<colgroup>${cols}</colgroup>${rowsHtml}</table></div>`
  )
}

/**
 * The tiny subset of markdown the summarizer emits: `**bold**`, `*italic*`, and
 * line breaks. Deliberately not the editor's markdown module — that one is
 * an interactive typing affordance and carries literal invisible characters;
 * this is a one-way formatter for text that arrived from the network, so it
 * escapes first and only then adds the two tags it trusts.
 */
export function summaryHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * The poll surface, shared by the static render and by present mode.
 *
 * present.ts finds the marked nodes (`.tessera-poll-live`, `.tessera-poll-count`…)
 * and fills them in rather than rebuilding the element, so the layout you see on
 * the canvas is exactly the layout the audience sees on the projector — and so
 * disposing the live widget is just "render this again".
 */
export function renderPollBody(el: PollElement, doc: TesseraDoc, opts: RenderOpts = {}): HTMLElement {
  const accent = el.accent || doc.theme.accent
  const ink = el.color || '#1E2A3A'
  const host = pollHost(el)
  // ONE code for the whole deck when the deck has a session: the audience scans
  // once and their page follows the speaker from question to question.
  const join = pollJoinCode(doc, el)
  // The bare host is what a person types; the scheme and any `www.` are noise
  // on a slide read from twenty feet away.
  const shortHost = host.replace(/^https?:\/\//, '').replace(/^www\./, '')

  const body = document.createElement('div')
  body.className = 'tessera-poll-body'
  body.style.cssText =
    `width:100%;height:100%;display:flex;gap:40px;align-items:flex-start;color:${ink};` +
    `font-family:${el.fontFamily || doc.theme.fontFamily};overflow:hidden`

  // --- main column: the question, then whatever we have to say about answers
  const main = document.createElement('div')
  main.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;height:100%'

  const q = document.createElement('div')
  q.className = 'tessera-poll-q'
  q.dir = 'auto' // same reasoning as text elements: the question may not be LTR
  q.style.cssText =
    `font-size:${el.fontSize ?? 40}px;font-weight:650;line-height:1.2;` +
    'white-space:pre-wrap;word-break:break-word'
  q.textContent = resolveFields(el.question || '', opts.fields)
  main.appendChild(q)

  // The live region. Static renders put the saved summary here; present mode
  // replaces the contents with the count, the button, and later the summary.
  const live = document.createElement('div')
  live.className = 'tessera-poll-live'
  live.style.cssText =
    'flex:1 1 auto;min-height:0;margin-top:22px;display:flex;flex-direction:column;' +
    'font-size:19px;line-height:1.45;overflow:hidden'
  // A multiple-choice question is only answerable if the room can SEE the
  // options, and a rating scale is meaningless without its ends — so both are
  // part of the static slide, not of the live widget. present.ts swaps this for
  // the results when the presenter reveals them, and puts it back when they hide.
  const tally = el.frozen ? renderFrozenResults(el, accent) : null
  const ask = tally ?? renderPollAsk(el, accent, opts)
  if (ask) live.appendChild(ask)

  if (el.summary) {
    const sum = document.createElement('div')
    sum.className = 'tessera-poll-summary'
    sum.style.cssText = 'overflow:auto;min-height:0'
    sum.innerHTML = summaryHtml(el.summary)
    live.appendChild(sum)
  }
  main.appendChild(live)
  body.appendChild(main)

  // A reporting slide reads back a bucket the room filled earlier, so it must
  // not print an invitation to answer — see PollElement.showJoin.
  if (el.showJoin === false || el.frozen) return body

  // --- side column: how to join
  const side = document.createElement('div')
  side.className = 'tessera-poll-join'
  side.style.cssText =
    'flex:0 0 auto;width:200px;display:flex;flex-direction:column;align-items:center;' +
    'gap:10px;text-align:center'

  // Thumbnails skip the QR entirely: a sidebar thumb is repainted constantly and
  // must never depend on the network (the same reason media renders a still).
  // No configured service, no QR either: `${''}/api/qr` is a RELATIVE url, which
  // would quietly ask whatever host the file happens to be open from.
  if (!opts.svgAsImage && host) {
    const qr = document.createElement('img')
    qr.className = 'tessera-poll-qr'
    qr.alt = ''
    qr.draggable = false
    // fg is passed because an SVG in an <img> is an isolated document — it
    // inherits no colour from the slide, so a dark deck needs light modules.
    qr.src = `${host}/api/qr?c=${encodeURIComponent(join)}&fg=${ink.replace('#', '')}`
    qr.style.cssText = 'width:168px;height:168px;display:block'
    // No network, no QR — the join line below is the whole fallback.
    qr.addEventListener('error', () => { qr.style.display = 'none' })
    side.appendChild(qr)
  }

  const joinLabel = document.createElement('div')
  joinLabel.style.cssText = 'font-size:15px;opacity:.72;line-height:1.35'
  // An unconfigured deck says so where the address would be. The alternative
  // is a bare code with nowhere to type it, discovered on stage.
  joinLabel.textContent = shortHost || t('This deck has no poll service yet.')
  side.appendChild(joinLabel)

  const chip = document.createElement('div')
  chip.className = 'tessera-poll-code'
  chip.style.cssText =
    `font-size:30px;font-weight:700;letter-spacing:.06em;color:${accent};` +
    'font-variant-numeric:tabular-nums;line-height:1'
  chip.textContent = join
  side.appendChild(chip)

  body.appendChild(side)
  return body
}

/** A frozen choice or rating question, as bars. Other kinds have nothing to
 *  draw statically: open text shows its saved summary, a quiz its options. */
function renderFrozenResults(el: PollElement, accent: string): HTMLElement | null {
  const answers = (el.frozen?.answers ?? []).map((text) => ({ text }))
  if (!answers.length) return null
  if (el.kind === 'choice') {
    const { rows, other, total } = tallyChoices(el, answers)
    return renderPollBars(other ? [...rows, { label: t('Other'), count: other }] : rows, accent, { total })
  }
  if (el.kind === 'rating') {
    const stats = ratingStats(el, answers)
    return renderPollBars(stats.rows.map((r) => ({ label: String(r.value), count: r.count })), accent, { total: stats.count })
  }
  return null
}

/**
 * What the room is being asked to choose between: the options of a `choice`
 * question or the ends of a `rating` scale. Null for open text, which needs no
 * scaffolding beyond the question itself.
 *
 * Shared by the static render and by present mode (which shows it whenever the
 * results are hidden), so the projector never displays a multiple-choice
 * question without its choices.
 */
export function renderPollAsk(
  el: PollElement,
  accent: string,
  opts: Pick<RenderOpts, 'hidePlaceholders'> = {},
): HTMLElement | null {
  // Inline-styled like the rest of the static body, so a printed deck and a
  // sidebar thumbnail show the choices even though neither depends on the
  // app's stylesheet for anything else in this element.
  if (el.kind === 'choice') {
    // A blank option is an unfinished one: it prompts the author on the canvas
    // (same idiom as text placeholders) and does not exist anywhere the
    // audience can see it. The service drops blanks too, so a half-written
    // question is never answerable in a shape the slide doesn't show.
    // data-poll-field: the canvas edits that option in place on double-click
    const options = (el.options ?? []).map((o, i) => ({ text: o.trim(), n: i + 1 }))
      .filter((o) => o.text || !opts.hidePlaceholders)
    if (!options.length) return null
    const wrap = document.createElement('ul')
    wrap.className = 'tessera-poll-options'
    wrap.style.cssText =
      'list-style:none;margin:0;padding:0;overflow:auto;min-height:0;' +
      'display:flex;flex-direction:column;gap:14px;font-size:26px'
    options.forEach((opt) => {
      const li = document.createElement('li')
      li.dir = 'auto'
      li.style.cssText = 'display:flex;align-items:center;gap:14px;line-height:1.25'
      const key = document.createElement('span')
      key.style.cssText =
        `flex:0 0 auto;width:1.55em;height:1.55em;border-radius:8px;background:${accent};` +
        'color:#fff;font-size:.72em;font-weight:700;display:flex;align-items:center;justify-content:center'
      key.textContent = String(opt.n)
      const label = document.createElement('span')
      label.style.cssText = 'min-width:0;word-break:break-word'
      label.dataset.pollField = `options.${opt.n - 1}`
      if (opt.text) {
        label.textContent = opt.text
      } else {
        label.style.opacity = '0.42'
        label.textContent = t('Option {n}', { n: opt.n })
      }
      li.append(key, label)
      wrap.appendChild(li)
    })
    if (!el.multi) return wrap
    // `multi` changes what pressing an option does on the phone, which the
    // static slide can't show — so it says so, once, in a muted line under
    // the list rather than changing the list itself.
    const container = document.createElement('div')
    container.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px'
    wrap.style.flex = '1 1 auto'
    container.appendChild(wrap)
    const hint = document.createElement('div')
    hint.style.cssText = 'font-size:15px;opacity:.6'
    hint.textContent = t('pick as many as apply')
    container.appendChild(hint)
    return container
  }

  if (el.kind === 'rating') {
    const { min, max } = ratingScale(el)
    const wrap = document.createElement('div')
    wrap.className = 'tessera-poll-scale'
    // Centred in the space the question leaves, rather than jammed against the
    // left edge: a scale is read as one object, and a row of numbers hugging
    // one side of a 1168px slide reads as a mistake.
    wrap.style.cssText =
      'flex:0 0 auto;width:100%;max-width:900px;margin:26px auto 0;align-self:center'

    // The number line: pips joined by the segments between them. Drawing the
    // rule as connectors (rather than one line behind the row) means the pips
    // need no opaque fill, so this renders identically on a white deck and on
    // a navy one — the element never learns its own background.
    const track = document.createElement('div')
    track.style.cssText = 'display:flex;align-items:center;width:100%'
    for (let v = min; v <= max; v++) {
      if (v > min) {
        const link = document.createElement('span')
        link.style.cssText = 'flex:1 1 auto;height:2px;background:currentColor;opacity:.22'
        track.appendChild(link)
      }
      const pip = document.createElement('span')
      pip.style.cssText =
        `flex:0 0 auto;width:70px;height:70px;border:2px solid ${accent};border-radius:50%;` +
        'display:flex;align-items:center;justify-content:center;' +
        'font-size:28px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1'
      pip.textContent = String(v)
      track.appendChild(pip)
    }
    wrap.appendChild(track)

    if (el.minLabel || el.maxLabel) {
      // Aligned to the ENDS of the line, under the pips they describe.
      const ends = document.createElement('div')
      ends.style.cssText =
        'display:flex;justify-content:space-between;gap:24px;margin-top:14px;' +
        'font-size:18px;opacity:.7'
      const lo = document.createElement('span')
      lo.dir = 'auto'
      lo.style.cssText = 'max-width:40%;text-align:left'
      lo.textContent = el.minLabel ?? ''
      lo.dataset.pollField = 'minLabel'
      const hi = document.createElement('span')
      hi.dir = 'auto'
      hi.style.cssText = 'max-width:40%;text-align:right'
      hi.textContent = el.maxLabel ?? ''
      hi.dataset.pollField = 'maxLabel'
      ends.append(lo, hi)
      wrap.appendChild(ends)
    }
    return wrap
  }

  if (el.kind === 'quiz') {
    // The room answers on their phones, so the slide shows WHAT is being asked
    // — the question list — and never the options, which would not fit and
    // which nobody reads off a projector while holding the same thing in their
    // hand. The right answers are not drawn anywhere until the results are.
    const questions = (el.questions ?? []).map((q, at) => ({ ...q, at })).filter((q) => q.q.trim() || !opts.hidePlaceholders)
    const wrap = document.createElement('ol')
    wrap.className = 'tessera-poll-quiz'
    wrap.style.cssText =
      'list-style:none;margin:0;padding:0;overflow:auto;min-height:0;' +
      'display:flex;flex-direction:column;gap:12px;font-size:24px;counter-reset:q'
    if (!questions.length) {
      if (opts.hidePlaceholders) return null
      const li = document.createElement('li')
      li.style.cssText = 'opacity:.42'
      li.textContent = t('Add questions in the panel')
      wrap.appendChild(li)
      return wrap
    }
    questions.forEach((q, i) => {
      const li = document.createElement('li')
      li.dir = 'auto'
      li.style.cssText = 'display:flex;align-items:baseline;gap:14px;line-height:1.3'
      const n = document.createElement('span')
      n.style.cssText =
        `flex:0 0 auto;color:${accent};font-weight:700;font-size:.8em;` +
        'font-variant-numeric:tabular-nums'
      n.textContent = `${i + 1}.`
      const label = document.createElement('span')
      label.style.cssText = 'min-width:0;word-break:break-word'
      label.dataset.pollField = `questions.${q.at}.q`
      if (q.q.trim()) {
        label.textContent = q.q
      } else {
        label.style.opacity = '0.42'
        label.textContent = t('Question {n}', { n: i + 1 })
      }
      li.append(n, label)
      wrap.appendChild(li)
    })
    return wrap
  }

  return null
}

/**
 * The results of a `choice` or `rating` question as bars — our own, in the
 * element's own ink, rather than a chart element: this has to draw correctly at
 * projector size in a live widget that repaints every three seconds, and it
 * needs no axes, no legend and no data model.
 *
 * `rows` are already tallied (model.tallyChoices / model.ratingStats) so the
 * slide, the panel and the spreadsheet export can never disagree about counts.
 */
export function renderPollBars(
  rows: Array<{ label: string; count: number }>,
  accent: string,
  opts: { total?: number } = {},
): HTMLElement {
  const total = opts.total ?? rows.reduce((n, r) => n + r.count, 0)
  // Bars are scaled to the LEADER, not to the total: with five options and an
  // even split every bar would otherwise be a fifth of the width and the shape
  // of the room's opinion would be invisible from the back.
  const peak = Math.max(1, ...rows.map((r) => r.count))

  const wrap = document.createElement('div')
  // Six rows is where a full-size distribution stops fitting the element box.
  wrap.className = rows.length > 5 ? 'tessera-poll-bars tessera-poll-bars-dense' : 'tessera-poll-bars'
  for (const row of rows) {
    const line = document.createElement('div')
    line.className = 'tessera-poll-barrow'

    const label = document.createElement('div')
    label.className = 'tessera-poll-barlabel'
    label.dir = 'auto'
    label.textContent = row.label

    const track = document.createElement('div')
    track.className = 'tessera-poll-bartrack'
    const fill = document.createElement('div')
    fill.className = 'tessera-poll-barfill'
    fill.style.background = accent
    fill.style.width = `${(row.count / peak) * 100}%`
    track.appendChild(fill)

    const value = document.createElement('div')
    value.className = 'tessera-poll-barvalue'
    value.textContent = total
      ? `${row.count} · ${Math.round((row.count / total) * 100)}%`
      : String(row.count)

    line.append(label, track, value)
    wrap.appendChild(line)
  }
  return wrap
}

/**
 * Render one element. The wrapper carries data-el-id (edit-time selection)
 * and data-flip-id (morph matching across slides). The flip id is the
 * element's `morphId` when set, else its `id` — so morph pairing can be
 * re-targeted without disturbing the stable identity used everywhere else.
 */
export function renderElement(el: SlideElement, doc: TesseraDoc, opts: RenderOpts = {}): HTMLElement {
  const node = document.createElement('div')
  node.className = `tessera-el tessera-el-${el.type}`
  node.dataset.elId = el.id
  node.dataset.flipId = morphKey(el)
  if (el.link) node.dataset.link = el.link
  if (el.group) node.dataset.group = el.group
  if (el.showOnHover) node.dataset.showOnHover = el.showOnHover
  applyElementFrame(node, el)

  switch (el.type) {
    case 'text': {
      node.style.display = 'flex'
      node.style.flexDirection = 'column'
      node.style.justifyContent = VALIGN[el.valign]
      const inner = document.createElement('div')
      inner.className = 'tessera-text-inner'
      // Base direction from the text itself. Without it every box is LTR, and
      // Arabic/Hebrew/Persian/Urdu render with their neutral characters in the
      // wrong place — a trailing full stop jumps to the head of the line, and
      // mixed-language runs reorder. PER ELEMENT, not per document: one deck
      // can hold an Arabic heading and an English caption and both are right.
      // This is about the CONTENT the author typed; it says nothing about the
      // editor's own language.
      inner.dir = 'auto'
      inner.style.fontSize = `${el.fontSize}px`
      inner.style.fontFamily = el.fontFamily || doc.theme.fontFamily
      inner.style.fontWeight = String(el.fontWeight)
      const cg = el.colorGradient
      if (cg && cg.stops && cg.stops.length) {
        inner.style.backgroundImage = cssLinearGradient(cg)
        inner.style.setProperty('-webkit-background-clip', 'text')
        inner.style.setProperty('background-clip', 'text')
        inner.style.color = 'transparent'
      } else {
        inner.style.color = el.color
      }
      // text-stroke composes on top: outline the glyphs (over gradient or solid fill)
      const ts = el.textStroke
      if (ts && ts.width) {
        inner.style.setProperty('-webkit-text-stroke', `${ts.width}px ${ts.color}`)
        if (ts.fill === 'none') inner.style.color = 'transparent'
      }
      inner.style.textAlign = el.align
      inner.style.lineHeight = String(el.lineHeight)
      if (el.letterSpacing) inner.style.letterSpacing = `${el.letterSpacing}px`
      inner.style.width = '100%'
      inner.innerHTML = resolveMath(sanitizeHtml(resolveFields(el.html, opts.fields)))
      if (el.align !== 'center' && el.align !== 'right') layoutListLines(inner, doc.theme.accent)
      // layout placeholder: prompt while empty (editor), gone while presenting
      const isEmpty = !inner.textContent?.trim() && !el.html.includes('<img')
      if (el.placeholder && isEmpty) {
        if (opts.hidePlaceholders) {
          node.style.display = 'none'
        } else {
          inner.textContent = el.placeholder
          inner.style.opacity = '0.38'
        }
      }
      node.appendChild(inner)
      break
    }
    case 'shape':
      node.appendChild(shapeSvg(el))
      break
    case 'table':
      node.dataset.table = '1'
      node.innerHTML = renderTableHtml(el, doc)
      break
    case 'image': {
      const img = document.createElement('img')
      img.src = resolveAsset(doc, el.src)
      img.draggable = false
      img.style.cssText = `width:100%;height:100%;object-fit:${el.fit};border-radius:${el.radius}px;display:block`
      node.appendChild(img)
      break
    }
    case 'media': {
      const radius = el.radius ?? 0
      if (opts.svgAsImage) {
        // thumbnails: a cheap still — poster (video) or an icon chip, never a
        // live media element.
        const still = document.createElement('div')
        still.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:${el.kind === 'video' ? '#0b0f14' : '#e7edf4'}`
        if (el.kind === 'video' && el.poster) {
          const img = document.createElement('img')
          img.src = resolveAsset(doc, el.poster)
          img.style.cssText = `width:100%;height:100%;object-fit:${el.fit ?? 'contain'};display:block`
          still.appendChild(img)
        } else {
          still.style.color = el.kind === 'video' ? '#ffffff' : '#5e7699'
          still.style.fontSize = '24px'
          still.textContent = el.kind === 'video' ? '▶' : '♪'
        }
        node.appendChild(still)
        break
      }
      const inert = opts.liveMedia ? '' : ';pointer-events:none'
      if (el.kind === 'audio') {
        // Render the browser's native <audio controls> AS-IS: it's already a
        // self-contained pill with its own surface. We add nothing behind it
        // and don't clip it to a radius (that just cut the control's own shape
        // and looked odd) — only centre it in the element box. Size the box to
        // the control's ~54px intrinsic height (defaultMedia audio uses 56).
        const audio = document.createElement('audio')
        if (el.src) audio.src = resolveAsset(doc, el.src)
        audio.controls = el.controls !== false
        audio.loop = !!el.loop
        audio.preload = 'metadata'
        audio.dataset.autoplay = el.autoplay ? '1' : ''
        audio.style.cssText = 'width:100%;display:block' + inert
        const wrap = document.createElement('div')
        wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center'
        if (!el.src) {
          wrap.style.cssText += ';background:#eef2f7;border-radius:10px;color:#93a2b6;font-size:13px'
          wrap.textContent = '♪ ' + 'No audio source'
        } else wrap.appendChild(audio)
        node.appendChild(wrap)
        break
      }
      const video = document.createElement('video')
      if (el.src) video.src = resolveAsset(doc, el.src)
      if (el.poster) video.poster = resolveAsset(doc, el.poster)
      video.controls = el.controls !== false
      video.loop = !!el.loop
      video.muted = el.muted !== false
      video.playsInline = true
      video.preload = 'metadata'
      video.dataset.autoplay = el.autoplay ? '1' : ''
      video.style.cssText = `width:100%;height:100%;object-fit:${el.fit ?? 'contain'};border-radius:${radius}px;display:block;background:#0b0f14` + inert
      if (!el.src) {
        const ph = document.createElement('div')
        ph.style.cssText = `width:100%;height:100%;border-radius:${radius}px;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#8fa0b6;font-size:14px`
        ph.textContent = '▶ No video source'
        node.appendChild(ph)
      } else {
        node.appendChild(video)
      }
      break
    }
    case 'poll': {
      // Static everywhere — question, join info, last saved summary. present.ts
      // enriches this same DOM with the live count / Summarize / responses
      // (mountLivePolls) and restores the static body on the way out.
      node.dataset.poll = '1'
      node.dataset.pollCode = el.code
      // No pointer-events:none here, unlike `media`: the static body is plain
      // divs and an undraggable <img>, so it neither swallows marquee selection
      // nor blocks the double-click that edits the question on canvas. The
      // interactive controls exist ONLY in present mode (mountLivePolls).
      node.appendChild(renderPollBody(el, doc, opts))
      break
    }
    case 'chart': {
      // Static SVG snapshot everywhere; present mode swaps in a live ECharts
      // instance (mountLiveCharts) for tooltips/zoom. Kept as innerHTML so
      // print and thumbnails need no chart runtime at render time.
      node.dataset.chart = '1'
      node.innerHTML = chartSnapshotSvg(el)
      const csvg = node.querySelector('svg')
      if (csvg) {
        csvg.setAttribute('preserveAspectRatio', 'none')
        csvg.style.cssText = 'width:100%;height:100%;display:block'
      }
      break
    }
    case 'svg': {
      const markup = svgMarkup(el, doc)
      if (opts.svgAsImage) {
        // thumbnails: one <img> instead of thousands of svg nodes
        const img = document.createElement('img')
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup)
        img.draggable = false
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
        node.appendChild(img)
        break
      }
      node.innerHTML = markup
      const svg = node.querySelector('svg')
      if (svg) {
        svg.style.width = '100%'
        svg.style.height = '100%'
        svg.style.display = 'block'
        if (el.css) {
          const style = document.createElementNS(SVG_NS, 'style')
          style.textContent = scopeCss(el.css, `[data-el-id="${CSS.escape(el.id)}"]`)
          svg.prepend(style)
        }
      }
      break
    }
    case 'embed': {
      const radius = el.radius ?? 0
      // A live frame cannot be rasterized, so every surface that snapshots a
      // slide (thumbnails, editor canvas, print) gets the poster instead.
      const live = opts.liveMedia || el.liveInEditor
      if (opts.svgAsImage || !live) {
        const still = document.createElement('div')
        still.style.cssText = `width:100%;height:100%;border-radius:${radius}px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#f2f4f9`
        if (el.poster) {
          const img = document.createElement('img')
          img.src = resolveAsset(doc, el.poster)
          img.draggable = false
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
          still.appendChild(img)
        } else {
          still.style.color = '#5e7699'
          still.style.fontSize = '24px'
          still.textContent = '⧉'
        }
        node.appendChild(still)
        break
      }
      const frame = document.createElement('iframe')
      frame.setAttribute('sandbox', embedSandbox(el))
      frame.setAttribute('loading', 'lazy')
      frame.setAttribute('title', 'Embedded page')
      // only the edit canvas edits figure text: never the show, a thumbnail or a player file
      const markup = embedMarkup(el, doc, !opts.liveMedia && !opts.svgAsImage && !doc.readonly)
      // A figure under construction runs from its source on the edit canvas
      // only; the show and a player file always get the page in the file.
      const dev = !opts.liveMedia && !doc.readonly && isLoopbackUrl(el.devSrc) ? el.devSrc! : ''
      if (dev) frame.src = dev
      else if (markup) { frame.srcdoc = markup; builtTexts.set(frame, textsOf(el)) }
      else if (el.src) frame.src = el.src
      frame.style.cssText = `width:100%;height:100%;border:0;display:block;border-radius:${radius}px;background:#fff`
      const zoom = el.zoom ?? 1
      if (zoom !== 1 && zoom > 0) {
        // Give the frame a larger logical viewport, then scale it back down to
        // the element box — the page lays out as if the window were bigger.
        node.style.overflow = 'hidden'
        frame.style.width = `${100 / zoom}%`
        frame.style.height = `${100 / zoom}%`
        frame.style.transformOrigin = '0 0'
        frame.style.transform = `scale(${zoom})`
      }
      node.appendChild(frame)
      // No page in the file, only an address on this machine: say so, because
      // it looks fine here and is blank everywhere else.
      if (!markup && !opts.liveMedia && isLoopbackUrl(el.src)) {
        const warn = document.createElement('div')
        warn.style.cssText = 'position:absolute;left:8px;top:8px;padding:4px 10px;background:#b3261e;color:#fff;font:600 15px/1.3 system-ui,sans-serif;pointer-events:none'
        warn.textContent = t('Figure is not in this file')
        node.appendChild(warn)
      }
      break
    }
  }
  return node
}

/** Render a full slide surface (background + elements) at model coordinates. */
export function renderSlide(slide: Slide, doc: TesseraDoc, opts: RenderOpts = {}): HTMLElement {
  const surface = document.createElement('div')
  surface.className = 'tessera-slide'
  surface.dataset.slideId = slide.id
  surface.style.width = `${doc.size.width}px`
  surface.style.height = `${doc.size.height}px`
  surface.style.background = slide.background
  const fields = opts.fields ?? fieldContext(doc, slide)
  for (const el of slide.elements) surface.appendChild(renderElement(el, doc, { ...opts, fields }))
  return surface
}

/** Scaled-down live preview used for sidebar thumbnails. */
export function renderThumbnail(slide: Slide, doc: TesseraDoc, width: number): HTMLElement {
  const scale = width / doc.size.width
  const box = document.createElement('div')
  box.className = 'tessera-thumb-surface'
  box.style.width = `${width}px`
  box.style.height = `${doc.size.height * scale}px`
  const inner = renderSlide(slide, doc, { svgAsImage: true })
  inner.style.transformOrigin = '0 0'
  inner.style.transform = `scale(${scale})`
  box.appendChild(inner)
  return box
}
