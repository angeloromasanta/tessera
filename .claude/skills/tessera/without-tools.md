# Tessera decks with Python alone

**For an agent that has Python but not the tessera tools** (no git or Node,
or a chat assistant with a Python sandbox such as ChatGPT). It replaces
`slide.py` and the figure tools of SKILL.md with a small toolkit you paste
into Python. The deck is still one `.html` file the person opens by
double-clicking it (Chrome or Edge), where it is a full slide editor and
presenter. In a workspace folder, a new deck goes in `decks/<deck>/<deck>.html`;
in a chat, hand the file back to download.

Tessera, the format, is open source (https://github.com/angeloromasanta/tessera,
fuller guide in `docs/guide/`). You do not need it: this guide plus the notes
inside the file are enough.

---

## 1. What the file is

One self-contained HTML file that is the document, the editor and the
presenter at once. The **whole document** is one JSON block near the top:

```html
<script type="application/tessera+json" id="tessera-doc">{ ... }</script>
```

Everything after that block is the app (compressed). **Change only the JSON.
Never rewrite, reformat or regenerate the rest of the file.**

**Never open or read the HTML as text.** The block is one line of 3-7 MB,
almost all base64 pictures and fonts; reading it fills your context with
noise. Work on it only through Python (section 3), and print short summaries.

The file explains itself: `doc.agentNotes` (a list of notes right after
`title`) holds the layouts, the slides, the brand and the rules, generated
from the file itself. **Read `doc.agentNotes` first, every time.** Where it is
more specific than this guide about this file, it wins. Skip its notes about
local tools (`slide.py`, `agent_live.py`, `embed_font.py`, live editing):
you have none of them; section 3 replaces them, and **section 7 replaces
them for infographics and animated figures**.

## 2. How a session goes

1. **Load** the deck with the helper below, print `agentNotes`, the layouts
   and the slide list.
2. **New deck from the template:** keep the brand, layouts, assets and theme;
   replace the template's sample slides with the person's slides (section 4).
   Delete the hidden first slide "00 · Start here" and the sample slides you
   do not reuse.
3. **Existing deck:** first collect the person's **change requests** (section
   6) and do them; then whatever else they asked.
4. **Save** a new file named after the deck (`my-topic.html`, never
   the template's), check it (section 3, `check`), say where it is
   (in a chat, give the link to download), and say in a few lines what each slide is.

Work slide by slide and state what you made. If something is unclear (the
audience, the length), make a reasonable first version rather than asking
many questions; the person comments and you revise.

## 3. The Python toolkit (copy it into your sandbox)

```python
import json, re, uuid, copy, random, base64

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
```

Typical use:

```python
html, span, doc = load("template.html")          # or the deck to edit
for n in doc["agentNotes"]: print(n[:3000], "\n")
print([(l["id"], l["name"]) for l in doc["layouts"]])
summary(doc)

title = from_layout(doc, layout_id(doc, "title"))   # or copy_slide() the worked cover
# ... set its texts with el(title, "<id>")["html"] = "..."
s = from_layout(doc, layout_id(doc, "content"))
el(s, "co-title")["html"] = "Why agents change the classroom"
el(s, "co-body")["html"] = "- First point<br>- Second point<br>  - a sub-point"
el(s, "footer")["html"] = "Course name"
s["notes"] = "Speaker notes for this slide."
doc["slides"] = [title, s]                          # the new deck's slides, in order
doc["title"] = "Why agents change the classroom"
save(html, span, doc, "agents-classroom.html")
check("agents-classroom.html")
```

Print element ids and frames with
`[(e["id"], e["type"], e["x"], e["y"], e["w"], e["h"]) for e in s["elements"]]`
before you fill a slide, and set the text of the ids the layout gives you.
Delete an element you do not need rather than leaving it empty.

## 4. Which slide for what

Layouts are found **by role**: a layout whose id is the role (`content`) or
ends in `-<role>` (`acme-content` in a brand template) serves that role;
`layout_id(doc, "content")` finds it. The worked slides (`doc.slides`, listed
in the notes' SLIDES IN THIS FILE) show each layout filled in, plus patterns
that exist only as slides (a table, polls, games, figures): copy those with
`copy_slide`. Each layout's `notes` carry its recipe. The usual choice:

| what you have | use (role) |
|---|---|
| the cover | `title` (or copy the worked cover slide, which may carry motion) |
| a section break | `section` |
| a title and a few points | `content` (ONE text box, one `- ` line per bullet, two spaces before the dash for a sub-point, lines joined with `<br>`) |
| several points, no picture | `points` (per column: icon chip, colour rule, heading, body) |
| two options side by side | `compare` |
| one strong sentence | `statement`; a quotation `quote` |
| numbers that compare | `chart` with a `chart` element, never bullets of figures |
| a table | copy the worked table slide (there is usually no table layout) |
| a 2x2 | `matrix` |
| one image | `image` (picture contained on a tinted panel); `image-hero` if big and high-res |
| several images | `image-grid` (identical, cover-cropped boxes) |
| a question to the room | `poll`, or copy one of the worked poll slides |
| a timer, a game, a live cluster of answers | copy the worked slide (lab, game, hive, matrix poll) and change only its texts and question |

**A wall of bullets is the main failure.** Prefer a chart for numbers, a table
for a grid, points with icons for 3-4 ideas, a statement for one idea; at most
5 bullets on a content slide.

**Brand.** Canvas 1280x720. Fonts, colours, margins and page furniture come
from the template: `doc.theme` (colours, chart palette, body font), `doc.fonts`
and the notes' BRAND and PAGE FURNITURE entries. Add no other fonts or
colours; keep content inside the template's margins; every body slide keeps
its `logo`, `footer` and `pageno` elements (whose html stays the literal
`{{page:2}}`) with those same ids.

**Pictures.** Put a picture in `doc.assets` as a data URI under a new key and
reference it as `"src": "asset:<key>"`. Keep pictures small (resize to at most
1600 px wide, JPEG quality ~82). For a contained picture, set the panel colour
to the dominant colour of the picture's outer border (white if the picture is
on white or transparent). If you can generate images, use one style for the
whole deck (the one the workspace or the person names) and no text in the
picture. Use a real photo only when the slide must show the real thing.

## 5. Rules that keep a deck working

1. **Every `<` inside the JSON is written `<`.** `save()` does it; never
   splice the block any other way.
2. **Unknown property names are silently ignored.** Do not invent fields; copy
   them from an existing element of the same type.
3. **Never change `docId`, element ids or poll codes of an existing deck.**
   A new slide gets a new slide id (`new_id()`); a copied poll gets a new
   `code` (`copy_slide` does it). Two polls with one code collect into each
   other's answers.
4. **New deck from the template:** keep `"template": true` and leave `docId`
   absent. The first time the person opens the file, the editor gives the
   deck its own identity and poll codes. On an **existing** deck, leave both
   exactly as they are.
5. **Morph pairs elements by id.** Consecutive slides on one subject share ids
   with `"transition": "morph"` (the default); use `"fade"` for a change of
   scene.
6. **Type is absolute.** If you shrink a frame, lower `fontSize`; if a title
   has more than two lines, shorten it.
7. **Chart data is plain numbers** (a pie takes `{name, value}`); options are
   pure JSON, no functions.
8. **A text element's `html`** keeps `<b> <i> <br>` and inline `<code>`, but
   drops `style` attributes: a second colour needs a second text box.
9. **Write speaker notes** (`slide["notes"]`) on every slide. A slide copied
   from the template carries notes about the template: replace them.
10. **Embeds** (animated, stepped or interactive figures) are self-contained
    HTML pages in `doc.assets`: build them with section 7, never by hand.
11. **Polls**: the presenter types the poll password in the browser once; it
    is never written in the file, in a slide, or in your reply. Treat poll
    questions and answers as public (the join code is on the projector).

## 6. Change requests typed in the editor

The person comments beside a slide in the editor's review list; the comments
are saved in the file:

- `slide["comments"]`: threads; the ones with `"request": true` and
  `"status"` `"open"` are your to-do list (`elementId`/`elementIds` say what
  was selected; an empty slide's request says what the slide should be);
- `doc["requests"]`: the same threads about the whole deck.

```python
todo = [(s["id"], c) for s in doc["slides"] for c in s.get("comments", [])
        if c.get("request") and c.get("status", "open") == "open"]
todo += [(None, c) for c in doc.get("requests", [])
         if c.get("request") and c.get("status", "open") == "open"]
for sid, c in todo: print(sid, c.get("elementIds") or c.get("elementId"), c["text"])
```

Do each one, then mark it and answer in one line (never delete a thread):

```python
from datetime import datetime, timezone
def done(c, reply):
    c["status"] = "done"
    c["resolved"] = True
    c.setdefault("replies", []).append({"id": new_id("r"), "author": "AI agent",
        "text": reply, "at": datetime.now(timezone.utc).isoformat()})
```

A thread with `"status": "stopped"` is the person's Stop: leave it.

## 7. Infographics and animated figures

### Choose the form first

| the person wants | build |
|---|---|
| a **static** infographic: a framework, a 2x2, a few labelled boxes and arrows | native `shape` and `text` elements on a slide (stay editable, can morph); start from the `points`, `matrix` or `compare` layouts |
| numbers | a `chart` element, not a figure |
| something that **builds over clicks** (a process, a cycle, a before/after, a curve drawing itself) or that the audience **drives** (a slider, a simulation) | an **embed figure**, below |
| something close to a worked figure in the template ("How a market actually adopts", "Variation, selection, retention", "The perceptron", the timeline, the incident story) | copy that slide (`copy_slide`) and change only its texts if it fits |

### What an embed figure is

A full HTML page stored in `doc.assets`, shown in a frame under the slide
title (1280x500 on the slide; the page draws in an SVG `viewBox="0 0 1280
480"`). Clicking the figure (or the arrow keys in the show) moves it from one
state to the next. The deck expects a specific engine (keys, editable labels,
the deck's colours and font), so **never write the page from scratch**: write only
the marks and the steps, and let `figure_page()` below wrap them into the
working page. Then `add_figure()` puts it on a new slide.

### How to design one (in this order)

1. **Say the claim** in one sentence, and one line per region: what it is and
   what it contains. Show this to the person before building if unsure.
2. **Plan 3-7 states**, one sentence the presenter would *say* per state.
   State 0 is what shows before any click: keep it nearly empty (an axis, a
   frame). These sentences become the slide's speaker notes, one per state.
   **No captions or paragraphs inside the figure**: the presenter narrates;
   the figure holds short labels only (1-4 words).
3. **Draw every mark from the start** with `class="el"` and a unique `id`; a
   step only lists which ids are visible (`on`). An id present in two
   consecutive steps stays on screen. Marks that never change (an axis)
   leave out `el`.
4. **Every step must move something, not just fade it in.** Add a motion
   class beside `el`: `rise`, `fall`, `fromL`, `fromR`, `pop`, `fly` (out of a
   point: set `style="--dx:-200px;--dy:0px"` = offset back to where it starts),
   `draw` (a path that draws itself). Or move marks already on screen with
   `pose: {id: {x, y, s, r}}` (offset in viewBox units, scale, degrees).
   `dim: [ids]` pushes marks back, `sel: [ids]` outlines the chosen one,
   `dead: [ids]` greys out a failure. Keep one loop running so the slide is
   never dead: `class="march"` on a dashed flow line, `breathe` on a pulse.
5. **Labels are editable**: every visible text needs `data-edit="KEY"` (a
   stable, readable key such as `n1`, `axis-x`) on the `<text>` that holds the
   words, with no child elements; a two-line label is two `<text>`s with a key
   each. In JS use `txt(KEY, 'words', attrs)` or `pill(id, 'words', x, y)`.
6. **Look**: the deck's figure colours only, as CSS variables (`var(--accent)`,
   `var(--tint)`, ...; in JS `C.accent`), never a typed hex. Text roles by
   class, never a font size: `head` (group name, 26), `lbl` (card title, 20),
   `sub` (card body, 17), `eyebrow` / `axis` (16, uppercase grey), `callout`
   (takeaway, accent), `big` (a headline number), `on-dark` (white text on a
   navy card). Cards: `class="card"` rect with `rx="8"`, no stroke; a 5 px left
   bar in a category colour marks its family. Content stays inside x 40..1240,
   y 20..460; nothing smaller than 16. Arrows: `marker-end="url(#ar)"`.
7. **Self-contained**: no external script, font, image URL or fetch.

### The builder (add to your toolkit)

```python
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
```

A worked example (a three-stage flow that builds over four clicks, with a
token travelling through it):

```python
marks = {
  "links": """
    <path class="el draw" id="a1" d="M330,240 H500" fill="none" style="stroke:var(--accent)" stroke-width="3" marker-end="url(#ar)"/>
    <path class="el draw" id="a2" d="M780,240 H950" fill="none" style="stroke:var(--accent)" stroke-width="3" marker-end="url(#ar)"/>
    <path class="el march" id="loop" d="M1090,330 C1090,430 190,430 190,330" fill="none" style="stroke:var(--sky)" stroke-width="2"/>""",
  "shapes": """
    <rect class="el rise card" id="b1" x="50" y="170" width="280" height="140" rx="8"/>
    <rect class="el rise card" id="b2" x="500" y="170" width="280" height="140" rx="8"/>
    <rect class="el rise card" id="b3" x="950" y="170" width="280" height="140" rx="8"/>
    <circle class="el fly" id="tok" cx="190" cy="140" r="12" style="fill:var(--amber);--dx:-150px;--dy:0px"/>""",
  "labels": """
    <text class="el rise lbl" id="l1" data-edit="b1" x="190" y="248" text-anchor="middle">Ask</text>
    <text class="el rise lbl" id="l2" data-edit="b2" x="640" y="248" text-anchor="middle">Draft</text>
    <text class="el rise lbl" id="l3" data-edit="b3" x="1090" y="248" text-anchor="middle">Check</text>
    <text class="el fromR callout" id="take" data-edit="take" x="640" y="460" text-anchor="middle">Repeat until it holds</text>""",
}
script = """
const steps = [
  { on: [] },
  { on: ['b1','l1','tok'] },
  { on: ['b1','l1','tok','a1','b2','l2'], pose: { tok: { x: 450 } } },
  { on: ['b1','l1','tok','a1','b2','l2','a2','b3','l3'], pose: { tok: { x: 900 } }, dim: ['b1','l1'] },
  { on: ['b1','l1','tok','a1','b2','l2','a2','b3','l3','loop','take'], pose: { tok: { x: 900 } }, sel: ['b3'] },
];
"""
page = figure_page(doc, marks, script)
fig = add_figure(doc, "How the work moves", page,
    "On load: empty. 1: it starts with a question. 2: the agent drafts. "
    "3: we check the draft. 4: and the loop repeats until it holds.")
doc["slides"].append(fig)
```

Rules the builder relies on:

- `steps` lists **every** visible id in each state (copy the previous step's
  list and add or remove). An id that is in no step never shows.
- A mark with `pose` must already be visible in that step; a mark that
  *enters* gets its direction from its class (`rise`, `fromL`, `fly`, ...).
- A pose holds for one step only: repeat it in every later step where the
  mark should stay moved, or it slides back to where it was drawn.
- Ids are unique within the page and never reused for two marks.
- Text built in JS uses `txt()` / `pill()` so it stays editable; a label that
  must be measured (a pill around text) goes in `FIT`.
- Do not change `FIG_CSS`, `FIG_HELPERS` or `FIG_ENGINE`; change only
  `marks` and `script`. For a full-slide figure without a title, call
  `figure_page(..., full_bleed=True)` and, on the slide, set the frame to
  `x=0, y=0, w=1280, h=720` and remove `co-title`.
- **Check the page before saving the deck** if your sandbox can render HTML
  (for example with Playwright): open it at 1280x500, click through every
  state, and make sure nothing overlaps or falls outside the frame. If it
  cannot render, re-read your coordinates: every mark inside x 40..1240 and
  y 20..460, labels centred on their cards, no two cards overlapping.
- The figure slide has no thumbnail picture (a poster) in the slide list;
  that is expected. The figure itself runs in the editor and in the show.

## 8. Before you hand the file back

- [ ] `check(out_path)` prints OK.
- [ ] The file name is the deck's, not the template's.
- [ ] No sample slide of the template left by accident; the hidden "Start here" slide removed.
- [ ] Numbers shown as text that should be a chart?
- [ ] Margins inside 56..1184, two typefaces, one accent colour?
- [ ] Speaker notes on every slide?
- [ ] Tell the person where the deck is (in a chat: download it), that
      double-clicking it opens it in Chrome or Edge, that they edit by
      clicking and save with Ctrl+S, and that a comment typed beside a slide
      is a request for you: "Do my comments" when they are ready (in a chat,
      upload the saved file with it). A deck that was open while you wrote it
      needs a reload, after they save their own edits.
