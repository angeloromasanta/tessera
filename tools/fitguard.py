"""Find (and with --fix repair) figure pages that scale themselves to a frame
with no size.

A page that does `scale(innerWidth / 1280)` once at load is blank when the
slideshow STARTS on its slide: the frame can run the script before it has a
size, the scale becomes 0, and no resize event follows. The guard: skip a zero
size, and fit again on load, on a ResizeObserver and on a 1 s timer.

    fitguard.py FILE.html ...        # figure sources: report, --fix patches in place
    fitguard.py --deck DECK.html     # every page asset in the deck: report,
                                     # --fix patches each and re-uploads it (slide.py asset)

Exit 1 when an unguarded page is left. The fix knows the house `fit` shapes
(`const fit = () => {` / `function fit() {` / `function fitStage() {` followed
by a Math.min of innerWidth and innerHeight); anything else is reported for a
hand edit.
"""
import argparse, base64, json, pathlib, re, subprocess, sys, tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deckio  # noqa: E402

HERE = pathlib.Path(__file__).parent
SIZE = re.compile(r'\b(?:window\.)?innerWidth\b')
GUARD = re.compile(r'if\s*\(\s*!\s*(?:window\.)?innerWidth|=\s*(?:window\.)?innerWidth\b[^;]*;\s*if\s*\(\s*!\s*w\b')
FIT = re.compile(r'Math\.min\(\s*(?:window\.)?innerWidth\s*/[^)]*innerHeight\s*/')
HEAD = re.compile(r'((?:const\s+(\w+)\s*=\s*\(\)\s*=>\s*\{|function\s+(\w+)\s*\(\)\s*\{)[ \t]*\n?)([ \t]*)(const\s+\w+\s*=\s*Math\.min\(\s*(?:window\.)?innerWidth)')


def scales(html):
    """True when the page turns the frame size into a transform scale."""
    return bool(FIT.search(html)) and 'scale(' in html


def guarded(html):
    return bool(GUARD.search(html))


def fix(html):
    """The page with the guard, or None when its fit function is not a known shape."""
    m = HEAD.search(html)
    if not m:
        return None
    name = m.group(2) or m.group(3)
    out = html[:m.end(1)] + m.group(4) + 'if (!window.innerWidth || !window.innerHeight) return;\n' + m.group(4) + html[m.start(5):]
    again = ('\n/* A frame can run this before it has a size (a slideshow started on this slide):\n'
             '   never scale to 0, and fit again once the frame is laid out. */\n'
             'window.addEventListener("load", %s);\n'
             'if (window.ResizeObserver) new ResizeObserver(%s).observe(document.documentElement);\n'
             'setInterval(%s, 1000);\n' % (name, name, name))
    call = re.compile(r'(?<![\w.])%s\(\);' % re.escape(name))
    hits = [c for c in call.finditer(out) if c.start() > m.end()]
    if not hits:
        return None
    c = hits[0]
    return out[:c.end()] + again + out[c.end():]


def deck_pages(path):
    raw = pathlib.Path(path).read_text(encoding='utf-8')
    m = deckio.DOC_RE.search(raw)
    if not m:
        sys.exit('no #' + deckio.DOC_ID + ' in ' + str(path))
    yield from doc_pages(json.loads(m.group(2)))


def doc_pages(doc):
    """(key, html) for every HTML page among a document's assets."""
    for key, a in (doc.get('assets') or {}).items():
        data = a if isinstance(a, str) else (a.get('data') or a.get('src') or a.get('html') or '')
        if not isinstance(data, str):
            continue
        if data.startswith('data:text/html'):
            head, _, body = data.partition(',')
            html = base64.b64decode(body).decode('utf-8', 'replace') if ';base64' in head else __import__('urllib.parse').parse.unquote(body)
        elif data.lstrip()[:15].lower().startswith(('<!doctype', '<html')):
            html = data
        else:
            continue
        yield key, html


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--deck')
    ap.add_argument('--fix', action='store_true')
    a = ap.parse_args()
    left = 0
    if a.deck:
        for key, html in deck_pages(a.deck):
            if not scales(html) or guarded(html):
                continue
            new = fix(html) if a.fix else None
            if new:
                with tempfile.TemporaryDirectory() as d:
                    f = pathlib.Path(d) / (key + '.html')
                    f.write_text(new, encoding='utf-8', newline='')
                    r = subprocess.run([sys.executable, str(HERE / 'slide.py'), 'asset', a.deck, key, str(f)],
                                       capture_output=True, text=True, encoding='utf-8')
                print('%s: %s  %s' % (key, 'fixed' if r.returncode == 0 else 'UPLOAD FAILED', (r.stdout + r.stderr).strip().splitlines()[-1][:120]))
                left += r.returncode != 0
            else:
                print('%s: scales to the frame, no guard%s' % (key, ' (unknown shape: edit by hand)' if a.fix else ''))
                left += 1
    for name in a.files:
        p = pathlib.Path(name)
        html = p.read_text(encoding='utf-8')
        if not scales(html) or guarded(html):
            continue
        new = fix(html) if a.fix else None
        if new:
            p.write_text(new, encoding='utf-8', newline='')
            print('%s: fixed' % name)
        else:
            print('%s: scales to the frame, no guard%s' % (name, ' (unknown shape: edit by hand)' if a.fix else ''))
            left += 1
    sys.exit(1 if left else 0)


if __name__ == '__main__':
    main()
