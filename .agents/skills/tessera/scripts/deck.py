"""Read and write a tessera deck with Python alone: no git, no Node, no live editor.

The deck is one .html file whose whole document is the JSON in its
`#tessera-doc` block; everything else in the file is the app and is never
touched. This module loads that JSON, saves it back escaped, builds slides
from the template's layouts, copies worked slides (with fresh poll codes),
answers the requests typed beside the slides, and builds animated figures
(`figure_page` + `add_figure`) in the deck's own figure colours and font.

    import sys; sys.path.insert(0, "<this folder>")
    from deck import *
    html, span, doc = load("template.html")
    ...
    save(html, span, doc, "my-talk.html"); check("my-talk.html")

Command line (small output, never the base64):
    python deck.py summary DECK.html     one line per slide
    python deck.py notes DECK.html       the template's own agent notes
    python deck.py layouts DECK.html     layout ids and names
    python deck.py requests DECK.html    the open requests typed beside the slides
    python deck.py check DECK.html       the block is valid, ids and poll codes unique

Its guide is without-tools.md, next to this folder. Part of tessera
(https://github.com/angeloromasanta/tessera), MIT.
"""
from __future__ import annotations

import base64
import copy
import json
import random
import re
import sys
import uuid
from datetime import datetime, timezone

# the document block (decks from before the rename carry an older name: same shape)
OPEN = re.compile(r'<script type="application/[a-z]+\+json" id="[a-z]+-doc">')

def load(path):
    html = open(path, encoding="utf-8").read()
    m = OPEN.search(html)
    start = m.end()
    end = html.index("</script>", start)
    doc = json.loads(html[start:end])
    ORIGINAL_SLIDES.update({s["id"]: copy.deepcopy(s) for s in doc["slides"]})
    return html, (start, end), doc

ORIGINAL_SLIDES = {}   # every slide as loaded, so a worked slide can still be copied
                       # after doc["slides"] has been replaced with the new deck's

def save(html, span, doc, out_path):
    s = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    s = s.replace("<", "\\u003c")          # REQUIRED: no raw '<' may stay in the block
    start, end = span
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html[:start] + s + html[end:])   # slicing, never re.sub (backslashes)

def check(path):
    html, span, doc = load(path)
    assert "<" not in html[span[0]:span[1]], "raw < in the JSON block"
    ids = [s["id"] for s in doc["slides"]]
    assert len(ids) == len(set(ids)), "duplicate slide ids"
    codes = [e["code"] for s in doc["slides"] for e in s["elements"] if e.get("type") == "poll"]
    assert len(codes) == len(set(codes)), "two polls share a code"
    for s in doc["slides"]:
        for e in s["elements"]:
            for k in ("src", "poster"):
                v = str(e.get(k, ""))
                if v.startswith("asset:"):
                    assert v[6:] in doc["assets"], f"missing asset {v}"
    print("OK", len(ids), "slides")

def summary(doc):
    for i, s in enumerate(doc["slides"]):
        texts = [re.sub(r"<[^>]+>", "", e.get("html", ""))[:60]
                 for e in s["elements"] if e["type"] == "text" and e.get("html")]
        print(i, s["id"], "|", s.get("name", ""), "|", "hidden" if s.get("hidden") else "",
              "|", [e["type"] for e in s["elements"]], "|", texts[:2])

def new_id(prefix="s"):
    return f"{prefix}-" + uuid.uuid4().hex[:10]

def from_layout(doc, layout_id, slide_id=None):
    """A fresh slide from a layout: same element ids (so the page chrome morphs)."""
    lay = next(l for l in doc["layouts"] if l["id"] == layout_id)
    s = copy.deepcopy(lay)
    s["id"] = slide_id or new_id()
    s.pop("name", None)
    s["notes"] = ""
    return s

def copy_slide(doc, slide_id):
    """A copy of a worked slide in the file (for patterns that are not layouts).
    Its poll gets a fresh answer bucket; a game page that names the old code
    gets its own copy of the page, pointed at the new one."""
    src = next((x for x in doc["slides"] if x["id"] == slide_id), None) or ORIGINAL_SLIDES[slide_id]
    s = copy.deepcopy(src)
    s["id"] = new_id()
    s.pop("comments", None)
    swap = {}
    for e in s["elements"]:
        if e.get("type") == "poll":
            swap[e["code"]] = e["code"] = mint_code(doc, set(swap.values()))
    for e in s["elements"]:
        if e.get("type") == "embed" and swap and e.get("asset") in doc["assets"]:
            page = doc["assets"][e["asset"]]
            b64 = page.startswith("data:") and ";base64," in page[:80]
            text = base64.b64decode(page.split(",", 1)[1]).decode("utf-8") if b64 else page
            if any(old in text for old in swap):
                for old, new in swap.items():
                    text = text.replace(old, new)
                key = e["asset"] + "-" + s["id"]
                doc["assets"][key] = (page.split(",", 1)[0] + "," +
                    base64.b64encode(text.encode("utf-8")).decode()) if b64 else text
                e["asset"] = key
    return s

def mint_code(doc, taken=()):
    # the alphabet leaves out characters a room misreads (0/o, 1/l/i, 5/s, 2/z)
    used = {e.get("code") for s in doc["slides"] for e in s["elements"]} | set(taken)
    while True:
        c = "".join(random.choices("abcdefghjkmnpqrtuvwxy346789", k=6))
        if c not in used:
            return c

def el(slide, el_id):
    return next(e for e in slide["elements"] if e["id"] == el_id)

def layout_id(doc, role):
    """The layout serving a role: its id is the role, or ends in -<role> (a brand template)."""
    return next(l["id"] for l in doc["layouts"] if l["id"] == role or l["id"].endswith("-" + role))


def done(c, reply):
    c["status"] = "done"
    c["resolved"] = True
    c.setdefault("replies", []).append({"id": new_id("r"), "author": "AI agent",
        "text": reply, "at": datetime.now(timezone.utc).isoformat()})


FIG_CSS = r"""
@font-face{font-family:Manrope;font-weight:200 800;src:url(MANROPE) format('woff2')}
__TOKENS__
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#fff;overflow:hidden;font-family:Manrope,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
#stage{height:100%;display:flex;flex-direction:column;cursor:pointer;user-select:none;-webkit-user-select:none;padding:0 28px 4px}
svg{flex:1;width:100%;min-height:0;display:block}
#world{transform-box:view-box;transform-origin:0 0;transition:transform 1s cubic-bezier(.4,0,.2,1)}
.el{opacity:0;transition:opacity .5s cubic-bezier(.4,0,.2,1)}
.el.on{opacity:1}
.draw{stroke-dashoffset:var(--len);transition:stroke-dashoffset 1s cubic-bezier(.35,0,.25,1),opacity .25s}
.draw.on{stroke-dashoffset:0}
.rise,.fall,.fromL,.fromR,.pop,.fly{transition:opacity .4s ease,transform .6s cubic-bezier(.22,1,.36,1)}
.rise:not(.on){transform:translateY(22px)} .fall:not(.on){transform:translateY(-22px)}
.fromL:not(.on){transform:translateX(-34px)} .fromR:not(.on){transform:translateX(34px)}
.pop,.fly{transform-box:fill-box;transform-origin:center}
.pop:not(.on){transform:scale(.72)}
.fly{transition:transform .85s cubic-bezier(.22,1,.36,1),opacity .3s ease}
.fly:not(.on){transform:translate(var(--dx,0),var(--dy,0)) scale(var(--s0,.12))}
.march{stroke-dasharray:10 8;animation:march 1.1s linear infinite}
@keyframes march{to{stroke-dashoffset:-18}}
.breathe{animation:breathe 3.2s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.5}}
.posed{transform-box:fill-box;transform-origin:center;transition:opacity .45s ease,transform .8s cubic-bezier(.22,1,.36,1)}
.el.on.posed{transform:translate(var(--tx,0),var(--ty,0)) scale(var(--sc,1)) rotate(var(--rot,0deg))}
.el.on.dim{opacity:.22} .el.on.dead{opacity:.34}
circle.dead,rect.dead{fill:var(--line)} path.dead,line.dead,polyline.dead{stroke:var(--line)}
.sel{stroke:var(--ink);stroke-width:3}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition-duration:.15s!important}
.rise,.fall,.fromL,.fromR,.pop,.fly{transform:none!important}}
.head{font-weight:700;font-size:26px;fill:var(--ink)}
.eyebrow,.axis{font-weight:600;font-size:16px;fill:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.lbl{font-weight:700;font-size:20px;fill:var(--ink)}
.sub{font-weight:500;font-size:17px;fill:var(--muted)}
.callout{font-weight:700;font-size:20px;fill:var(--accent)}
.big{font-weight:700;font-size:52px;fill:var(--ink)}
.on-dark{fill:#fff} .on-dark.sub{fill-opacity:.85}
.card{fill:var(--tint)}
#bar{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:6px 0 4px;font-size:13px;color:var(--muted)}
#dots{display:flex;gap:7px}
#dots i{width:8px;height:8px;border-radius:50%;background:var(--rule);transition:background .3s}
#dots i.on{background:var(--accent)}
#hint{margin-left:auto;opacity:.75}
"""

FIG_HELPERS = r"""
const SVG='http://www.w3.org/2000/svg';
const C=(()=>{const r=[...document.styleSheets[0].cssRules].find(r=>r.selectorText===':root');
  return Object.fromEntries([...r.style].filter(p=>p.startsWith('--')).map(p=>[p.slice(2),r.style.getPropertyValue(p).trim()]));})();
const layer={links:document.getElementById('links'),shapes:document.getElementById('shapes'),labels:document.getElementById('labels')};
function mk(tag,attrs,parent){const e=document.createElementNS(SVG,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);(parent||layer.shapes).appendChild(e);return e;}
const T=(k,d)=>(window.TESSERA_EMBED&&TESSERA_EMBED.text)?TESSERA_EMBED.text(k,d):d;
function txt(key,text,attrs,parent=layer.labels){const t=mk('text',{...attrs,'data-edit':key},parent);t.textContent=T(key,text);return t;}
const FIT=[];function refit(){FIT.forEach(f=>f());}
window.TESSERA_REFIT=refit;document.fonts.ready.then(refit);
document.fonts.addEventListener('loadingdone',refit);
new ResizeObserver(refit).observe(document.getElementById('fig'));
function pill(id,text,x,y,{anchor='middle',color=C.ink,cls='lbl',padX=12,padY=5,parent=layer.labels,key=id}={}){
  const g=mk('g',{class:'el',id},parent);const r=mk('rect',{fill:'#fff',stroke:color,'stroke-width':2},g);
  const t=txt(key,text,{class:cls,x,y,'text-anchor':anchor,style:`fill:${color}`},g);
  const fit=()=>{const b=t.getBBox();const h=b.height+2*padY;r.setAttribute('x',b.x-padX);r.setAttribute('y',b.y-padY);
    r.setAttribute('width',b.width+2*padX);r.setAttribute('height',h);r.setAttribute('rx',h/2);};
  fit();FIT.push(fit);return g;}
const spotlight=(ids,s=2.4)=>Object.fromEntries(ids.map(id=>[id,{s}]));
function onto(id,toId){const a=document.getElementById(id),b=document.getElementById(toId);if(!a||!b)return{};
  try{const p=a.getBBox(),q=b.getBBox();return{x:+(q.x+q.width/2-p.x-p.width/2).toFixed(1),y:+(q.y+q.height/2-p.y-p.height/2).toFixed(1)};}catch(e){return{};}}
function stagger(ids,ms=40,base=0){ids.forEach((id,k)=>{const e=typeof id==='string'?document.getElementById(id):id;if(e)e.style.transitionDelay=(base+k*ms)+'ms';});}
const VBW=1280,VBH=__VBH__;const FULL=[0,0,VBW,VBH];const world=document.getElementById('world');
function camFit(ids,pad=26){const bs=ids.map(id=>document.getElementById(id)).filter(Boolean).map(e=>{try{return e.getBBox();}catch(err){return null;}}).filter(Boolean);
  if(!bs.length)return FULL;let x0=Math.min(...bs.map(b=>b.x))-pad,y0=Math.min(...bs.map(b=>b.y))-pad,
  w=Math.max(...bs.map(b=>b.x+b.width))+pad-x0,h=Math.max(...bs.map(b=>b.y+b.height))+pad-y0;const A=VBW/VBH;
  if(w/h<A){const n=h*A;x0-=(n-w)/2;w=n;}else{const n=w/A;y0-=(n-h)/2;h=n;}return[x0,y0,w,h];}
function camTo(rect){const[x,y,w,h]=rect;const s=Math.min(VBW/w,VBH/h,3.2);
  world.style.transform=`translate(${(VBW/2-s*(x+w/2)).toFixed(2)}px,${(VBH/2-s*(y+h/2)).toFixed(2)}px) scale(${s.toFixed(4)})`;}
"""

FIG_ENGINE = r"""
document.querySelectorAll('.draw').forEach(p=>{const L=p.getTotalLength();p.style.strokeDasharray=L+' '+L;p.style.setProperty('--len',L);});
let i=0;const els=[...document.querySelectorAll('.el')];const POSED=new Set();
steps.forEach(s=>Object.keys(s.pose||{}).forEach(id=>POSED.add(id)));
POSED.forEach(id=>document.getElementById(id)?.classList.add('posed'));
function setPose(e,p){e.style.setProperty('--tx',(p.x||0)+'px');e.style.setProperty('--ty',(p.y||0)+'px');
  e.style.setProperty('--sc',p.s==null?1:p.s);e.style.setProperty('--rot',(p.r||0)+'deg');}
const dotBox=document.getElementById('dots');dotBox.innerHTML=steps.map(()=>'<i></i>').join('');const dots=[...dotBox.children];
function draw(){refit();const s=steps[i];
  els.forEach(e=>{e.classList.toggle('on',s.on.includes(e.id));
    for(const k of['dim','dead','sel'])e.classList.toggle(k,(s[k]||[]).includes(e.id));
    if(POSED.has(e.id)){const p=(s.pose||{})[e.id];setPose(e,(typeof p==='function'?p():p)||{});}});
  if(s.do)s.do(s);camTo(typeof s.cam==='function'?s.cam():(s.cam||FULL));
  dots.forEach((d,n)=>d.classList.toggle('on',n<=i));
  document.getElementById('hint').textContent=i===steps.length-1?'click to restart':'click to advance';}
function go(n){i=(n+steps.length)%steps.length;draw();}
document.getElementById('stage').addEventListener('click',()=>go(i+1));
window.TESSERA_STEPPED=true;
addEventListener('keydown',e=>{const fwd=['ArrowRight',' ','Enter','PageDown'].includes(e.key);
  const back=['ArrowLeft','PageUp'].includes(e.key);
  if(fwd&&i<steps.length-1){go(i+1);e.preventDefault();}
  if(back&&i>0){go(i-1);e.preventDefault();}
  if(e.key==='Home'){go(0);e.preventDefault();}});
draw();
"""

# The starter's neutral figure colours; a template that defines its own figure
# family (its agent notes, "FIGURE STYLE") overrides any of them (deck_tokens).
NEUTRAL_TOKENS = {"ink": "#1A2326", "navy": "#0D2A2F", "accent": "#0F6B73", "sky": "#2B6CB0",
    "muted": "#5A6467", "faint": "#A7AFB1", "line": "#C7CFD1", "rule": "#D7DEDF", "tint": "#F1F5F5",
    "blue-tint": "#E2F0F1", "amber": "#BF831A", "amber-text": "#8E5F00", "amber-tint": "#FCF0DA",
    "green": "#3B9457", "green-text": "#2B7041", "green-tint": "#E3F2E6", "coral": "#D2553A",
    "coral-text": "#A83A20", "coral-tint": "#FBE8E2"}

def deck_tokens(doc):
    t = dict(NEUTRAL_TOKENS)
    for n in doc.get("agentNotes", []):
        if "FIGURE STYLE" in n[:200]:
            t.update({k: v for k, v in re.findall(r"--([a-z-]+):\s*(#[0-9A-Fa-f]{6})", n) if k in t})
    return ":root{" + ";".join(f"--{k}:{v}" for k, v in t.items()) + "}"

def body_font(doc):
    """The deck's own body font (Latin subset), as a data URI, so the figure matches the slides."""
    fam = doc["theme"]["fontFamily"].split(",")[0].strip().strip("'\"")
    fonts = [f for f in doc.get("fonts", []) if f["family"] == fam] or doc.get("fonts", [])
    fonts.sort(key=lambda f: "ext" in f["asset"])
    return fam, doc["assets"][fonts[0]["asset"]]

def figure_slide_id(doc):
    """A worked slide with a slide title and a figure frame under it (no poll): the one to copy."""
    for s in list(doc["slides"]) + list(ORIGINAL_SLIDES.values()):
        ids = {e["id"]: e for e in s["elements"]}
        f = ids.get("em-frame")
        if (not s.get("hidden") and "co-title" in ids and f and f["type"] == "embed"
                and f["y"] >= 100 and not any(e["type"] == "poll" for e in s["elements"])):
            return s["id"]
    raise KeyError("no worked figure slide (title + em-frame) in this deck")

def figure_page(doc, marks, script, full_bleed=False):
    """marks: SVG for the three layers, as a dict {"links": "...", "shapes": "...", "labels": "..."}
    (any may be ""). script: JS that may build more marks with mk/txt/pill and MUST define
    `const steps = [...]` (one object per state: {on:[ids], pose?, dim?, sel?, dead?, cam?, do?})."""
    vbh = 720 if full_bleed else 480
    fam, font = body_font(doc)
    css = (FIG_CSS.replace("__TOKENS__", deck_tokens(doc))
           .replace("font-family:Manrope;", f"font-family:'{fam}';").replace("url(MANROPE)", "url(" + font + ")")
           .replace("font-family:Manrope,", f"font-family:'{fam}',"))
    return ("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><title>figure</title><style>"
        + css + "</style></head><body><div id='stage'>"
        + f"<svg id='fig' viewBox='0 0 1280 {vbh}' preserveAspectRatio='xMidYMid meet'><defs>"
        + "<marker id='ar' viewBox='0 0 10 10' refX='7' refY='5' markerWidth='6' markerHeight='6' orient='auto'>"
        + "<path d='M0,1.2 L9,5 L0,8.8 z' style='fill:var(--accent)'/></marker></defs><g id='world'>"
        + "<g id='links'>" + marks.get("links", "") + "</g><g id='shapes'>" + marks.get("shapes", "")
        + "</g><g id='labels'>" + marks.get("labels", "") + "</g></g></svg>"
        + "<div id='bar'><div id='dots'></div><div id='hint'></div></div></div><script>"
        + FIG_HELPERS.replace("__VBH__", str(vbh)) + "\n" + script + "\n" + FIG_ENGINE
        + "</script></body></html>")

def add_figure(doc, title, page, notes, footer=""):
    """A new slide: the slide title above, the figure in the frame below. Returns the slide."""
    s = copy_slide(doc, figure_slide_id(doc))        # the template's figure slide: title + frame + chrome
    s["name"] = title
    el(s, "co-title")["html"] = title
    if any(e["id"] == "footer" for e in s["elements"]):
        el(s, "footer")["html"] = footer
    frame = el(s, "em-frame")
    key = "page-" + s["id"]
    doc["assets"][key] = page
    frame["asset"] = key
    frame["liveInEditor"] = True                     # the editor runs the page itself
    frame.pop("poster", None)                        # the template's poster shows another figure
    frame.pop("texts", None)
    s["notes"] = notes                               # one sentence per state, in order
    return s


def open_requests(doc):
    """[(slide id or None for the whole deck, thread)] for every open request."""
    out = [(s["id"], c) for s in doc["slides"] for c in s.get("comments", [])
           if c.get("request") and c.get("status", "open") == "open"]
    out += [(None, c) for c in doc.get("requests", [])
            if c.get("request") and c.get("status", "open") == "open"]
    return out


def _main(argv):
    if len(argv) != 3 or argv[1] not in ("summary", "notes", "layouts", "requests", "check"):
        print(__doc__)
        return 2
    cmd, path = argv[1], argv[2]
    if cmd == "check":
        check(path)
        return 0
    _, _, doc = load(path)
    if cmd == "summary":
        summary(doc)
    elif cmd == "notes":
        for n in doc.get("agentNotes", []):
            print(n, end="\n\n")
    elif cmd == "layouts":
        for l in doc["layouts"]:
            print(l["id"], "|", l.get("name", ""))
    else:
        todo = open_requests(doc)
        for sid, c in todo:
            print(sid or "[deck]", "|", c["id"], "|", c.get("elementIds") or c.get("elementId") or "", "|", c["text"])
        if not todo:
            print("no open requests")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv))
