"""python test/live_browser.py — the live link in a real browser, against `wrangler dev`.

A page that polls every 200 ms must reach the network only when its poll or
join code changes: a figure in a deck, the join page following the speaker, and
an activity page inside the join page, a game page (and one written before the
rename, test/legacy.py). Reads the throwaway key from .dev.vars.
"""
import json, os, random, re, socket, string, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
import legacy

HERE = Path(__file__).resolve().parent.parent
_vars = HERE / ".dev.vars"
_m = re.search(r"^\s*LECTURER_PASSWORD\s*=\s*(.*)$", _vars.read_text(), re.M) if _vars.exists() else None
if not _m or not _m.group(1).strip():
    sys.exit("No LECTURER_PASSWORD in .dev.vars: run `npm run setup` first (or write LECTURER_PASSWORD=<any throwaway key> to server/poll-worker/.dev.vars).")
KEY = _m.group(1).strip().strip('"').strip("'")
with socket.socket() as s:
    s.bind(("127.0.0.1", 0)); PORT = s.getsockname()[1]
BASE = f"http://127.0.0.1:{PORT}"
run = "".join(random.choice("abcdefghjkmnpqrtuvwxy346789") for _ in range(5))
C, CTRL, ACT, S = "f" + run, "k" + run, "g" + run, "s" + run

wr = subprocess.Popen(f"npx wrangler dev --port {PORT} --ip 127.0.0.1", cwd=HERE, shell=True,
                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

def call(method, path, body=None, key=False):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **({"x-tessera-lecturer": KEY} if key else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")

def joined(page):
    """The #g text of the game frame inside the join page, parsed, or None."""
    for _ in range(50):
        try:   # the frame may be navigating (a new srcdoc): look again next round
            f = next((f for f in page.frames if f != page.main_frame and f.query_selector("#g")), None)
            if f and (f.inner_text("#g") or "-") != "-":
                return json.loads(f.inner_text("#g"))
        except Exception as e:
            if "context was destroyed" not in str(e) and "detached" not in str(e):
                raise
        page.wait_for_timeout(200)
    return None

def stop():
    if os.name == "nt":
        subprocess.run(["taskkill", "/pid", str(wr.pid), "/T", "/F"], capture_output=True)
    else:
        wr.kill()

try:
    for _ in range(120):
        try:
            call("GET", "/api/lecturer"); break
        except Exception:
            time.sleep(0.5)
    else:
        raise SystemExit("wrangler dev did not start")

    with sync_playwright() as p:
        b = p.chromium.launch()

        # --- 1. a figure in a deck: polls every 200 ms ------------------------
        pg = b.new_page()
        hits = []
        pg.on("request", lambda r: hits.append(r.url) if "/api/poll" in r.url else None)
        pg.set_content("<html><body>figure</body></html>")
        pg.add_script_tag(url=BASE + "/live.js")
        pg.evaluate("""([base, c, key]) => {
          window.last = null;
          setInterval(() => fetch(base + '/api/poll?c=' + c, { cache: 'no-store', headers: { 'x-tessera-lecturer': key } })
            .then(r => r.json()).then(d => { window.last = d; }), 200);
        }""", [BASE, C, KEY])
        pg.wait_for_timeout(3000)
        quiet = len(hits)
        print("figure, 3 s of 200 ms polling, nothing new:", quiet, "network reads (was ~15)")
        assert quiet <= 3, hits
        call("POST", "/api/answer", {"code": C, "text": "hello"})
        pg.wait_for_timeout(1500)
        after = len(hits)
        print("figure, after one answer:", after - quiet, "more")
        assert 1 <= after - quiet <= 2, hits
        assert pg.evaluate("window.last.count") == 1 and pg.evaluate("window.last.answers[0].text") == "hello"

        # --- 2. the join page following the speaker ---------------------------
        call("POST", "/api/session", {"s": S, "active": {"code": C, "kind": "open", "question": "First question?"}}, key=True)
        ph = b.new_page(viewport={"width": 390, "height": 780})
        sess = []
        ph.on("request", lambda r: sess.append(r.url) if "/api/session" in r.url else None)
        ph.goto(f"{BASE}/{S}")
        ph.wait_for_selector("text=First question?", timeout=8000)
        ph.wait_for_timeout(6000)
        print("join page, 6 s, speaker idle:", len(sess), "session reads (was ~3-4)")
        assert len(sess) <= 3, sess
        n0 = len(sess)
        call("POST", "/api/session", {"s": S, "active": {"code": C, "kind": "open", "question": "Second question?"}}, key=True)
        ph.wait_for_selector("text=Second question?", timeout=5000)
        print("join page, speaker moved: shown after", len(sess) - n0, "read(s)")

        # --- 3. an activity page on the phone that follows a control bucket ----
        game = """<!doctype html><body><div id=o>-</div><script>
          var n = 0; setInterval(function () {
            fetch('/api/poll?c=%s', { cache: 'no-store' }).then(function (r) { return r.json(); })
              .then(function (d) { document.getElementById('o').textContent = 'step ' + (d.html || '-'); });
          }, 300);
        </script></body>""" % CTRL
        call("POST", "/api/poll", {"code": ACT, "html": game}, key=True)
        call("POST", "/api/poll", {"code": CTRL, "html": "0"}, key=True)
        act = []
        ph.on("request", lambda r: act.append(r.url) if ("/api/poll?c=" + CTRL) in r.url else None)
        call("POST", "/api/session", {"s": S, "active": {"code": ACT, "kind": "activity", "question": "Play"}}, key=True)
        frame = None
        for _ in range(50):
            frame = next((f for f in ph.frames if f != ph.main_frame and f.query_selector("#o")), None)
            if frame and "step 0" in (frame.inner_text("#o") or ""):
                break
            ph.wait_for_timeout(200)
        assert frame, "activity frame never loaded"
        ph.wait_for_timeout(3000)
        quiet = len(act)
        print("activity, 3 s of 300 ms polling, nothing new:", quiet, "network reads (was ~10)")
        assert quiet <= 3, act
        call("POST", "/api/poll", {"code": CTRL, "html": "1"}, key=True)
        for _ in range(25):
            if "step 1" in frame.inner_text("#o"):
                break
            ph.wait_for_timeout(200)
        assert "step 1" in frame.inner_text("#o")
        print("activity, after the screen stepped:", len(act) - quiet, "more")

        # --- 4. a game page: the device token, the SDK, the phone frame -------
        GAME = "h" + run
        page = """<!doctype html><meta name="tessera-game"><body><div id=g>-</div><script>
          var a = window.TESSERA_ACTIVITY || {};
          fetch('/api/game?c=' + a.code, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tessera-player': a.player },
                 body: JSON.stringify({ code: a.code, op: 'join', name: 'Phone' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { document.getElementById('g').textContent = JSON.stringify({ player: a.player, pid: d.pid, sdk: typeof window.TesseraGame }); });
        </script></body>"""
        call("POST", "/api/poll", {"code": GAME, "html": page}, key=True)
        call("POST", "/api/session", {"s": S, "active": {"code": GAME, "kind": "activity", "question": "Game"}}, key=True)
        got = joined(ph)
        assert got, "game frame never joined"
        assert re.fullmatch(r"[A-Za-z0-9_-]{24}", got["player"]), got
        assert got["player"] == ph.evaluate("localStorage.getItem('tessera-device')"), got
        assert re.fullmatch(r"[a-z2-7]{12}", got["pid"] or ""), got
        sdk_file = HERE / "public" / "game.js"
        if sdk_file.exists() and "TesseraGame" in sdk_file.read_text(encoding="utf-8"):
            assert got["sdk"] != "undefined", got
        elif sdk_file.exists():
            print("note: public/game.js predates the rename (no TesseraGame); run `npm run sync` once slides/src/game-sdk.js has it")
        sandbox = ph.get_attribute("#activityFrame", "sandbox")
        assert "allow-popups" in sandbox and "allow-same-origin" not in sandbox, sandbox
        assert "camera" in (ph.get_attribute("#activityFrame", "allow") or "")
        print("game page: token", got["player"][:4] + "…", "pid", got["pid"], "SDK", got["sdk"])

        # --- 5. before the rename: an old phone and an old game page ----------
        OLD = "o" + run
        old_token = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(24))
        ctx = b.new_context(viewport={"width": 390, "height": 780})
        ctx.add_init_script("try { localStorage.setItem(%s, %s) } catch (e) {}" % (json.dumps(legacy.OLD_DEVICE_KEY), json.dumps(old_token)))
        call("POST", "/api/poll", {"code": OLD, "html": legacy.OLD_GAME_PAGE}, key=True)
        call("POST", "/api/session", {"s": S, "active": {"code": OLD, "kind": "activity", "question": "Old game"}}, key=True)
        po = ctx.new_page()
        po.goto(f"{BASE}/{S}")
        old = joined(po)
        assert old, "old game frame never joined"
        assert old["player"] == old_token, old                      # the token stored under the old key is kept
        assert po.evaluate("localStorage.getItem('tessera-device')") == old_token
        assert re.fullmatch(r"[a-z2-7]{12}", old["pid"] or ""), old  # the old header reached /api/game
        if (HERE / "public" / "game.js").exists():
            assert old["sdk"] != "undefined", old                   # the old meta still gets the SDK, under its old name
        print("old game page: same token, pid", old["pid"], "SDK", old["sdk"])
        ctx.close()
        b.close()
    print("live browser: ok")
except Exception:
    stop()
    out = wr.stdout.read1(20000).decode(errors="replace") if wr.stdout else ""
    print(out[-3000:])
    raise
finally:
    stop()
