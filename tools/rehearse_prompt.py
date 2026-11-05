"""Rehearse the prompt game (kit/engage/prompt-screen.html + prompt-phone.html) offline.

    python tools/rehearse_prompt.py [--screen S.html --phone P.html] [--out DIR]

The screen and six phones against mock_service.py (never the real service, never
the lecturer key from .env), with the game SDK injected as the deck and the join
page do. The model is canned: the mock answers the phone's `draw` task (declared
in the phone page's tessera-ai tag) with a drawing picked by a word in the
student's prompt. Plays: the joins, several prompts per phone (fenced and plain
replies, one that hangs, one that throws), the wall closest first, "The prompts"
listing every prompt per student in order, scrolling that list without stepping
the slide, the ranking closing the phones (a prompt then is refused before any AI
call), each phone's own place, a phone reload restoring its history, a screen
reload resuming, a second screen following, the Phones button, Remove, Reset
(phones rejoin, history gone) and a screen without the key. Screenshots in --out
(default: tessera-rehearse-prompt in the system temp folder).
"""
import argparse
import json
import pathlib
import re
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ASSETS = HERE.parent / "kit" / "engage"      # the pages
from mock_service import MockService, open_phones, open_screen  # noqa: E402
from shoot import find_chrome  # noqa: E402

CODE = "pr7m3q"
fails = []
ART = re.compile(r"/\* art:begin \*/(.*?)/\* art:end \*/", re.S)


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        fails.append(what)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--screen", default=str(ASSETS / "prompt-screen.html"))
    ap.add_argument("--phone", default=str(ASSETS / "prompt-phone.html"))
    ap.add_argument("--out", default=str(pathlib.Path(tempfile.gettempdir()) / "tessera-rehearse-prompt"))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    screen_src = pathlib.Path(a.screen).read_text(encoding="utf-8")
    phone_src = pathlib.Path(a.phone).read_text(encoding="utf-8")

    sa, pa = ART.search(screen_src), ART.search(phone_src)
    check(bool(sa and pa) and sa.group(1) == pa.group(1), "art() and TARGET are the same text on the screen and the phone")
    m = re.search(r'<script type="application/json" id="tessera-ai">(.*?)</script>', phone_src, re.S)
    task = json.loads(m.group(1))["tasks"]["draw"] if m else {}
    check(bool(task.get("system")) and task.get("max", 0) <= 1500 and "PROBLEM" not in task["system"],
          "the phone declares the draw task (system prompt, max <= 1500), with no planted-error verdict")
    check(not re.search(r"fetch\(|XMLHttpRequest\(|['\"]/api/", phone_src + screen_src),
          "no fetch of its own: no /api/draw, no /api/answer, no extra buckets (everything through the SDK)")

    canned = {}

    def draw_reply(task_name, body):
        """The mock model: the student's latest words pick the drawing."""
        said = str(body.get("input", "")).rsplit("\n\n", 1)[-1].lower()
        for word, js in canned.items():
            if word in said:
                return {"text": js}
        return {"text": canned["default"]}

    svc = MockService(ai={"draw": draw_reply})
    svc.sdk_source()
    from playwright.sync_api import sync_playwright
    errs = []
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=find_chrome())
        ctx = br.new_context()
        svc.attach(ctx)
        sc = open_screen(ctx, svc, screen_src, CODE, errors=errs)
        G = svc.game(CODE)

        def wait(page, js, what, timeout=9000):
            try:
                page.wait_for_function(js, timeout=timeout)
                return True
            except Exception:
                check(False, f"timed out: {what}")
                return False

        def shot(name, page=None):
            (page or sc).screenshot(path=str(out / f"{name}.png"), full_page=page is not None)

        # the canned drawings, made by the page's own art()
        A = lambda o: sc.evaluate(f"art({json.dumps(o)})")
        canned.update({
            "exactly": sc.evaluate("TARGET"),
            "pulse": A({"hold": 1}),
            "star": A({"ease": False, "R": 60}),
            "square": "function draw(ctx,t){ctx.translate(160,90);ctx.rotate(t*6.283);ctx.strokeStyle='#1A2326';ctx.strokeRect(-50,-50,100,100)}",
            "fence": "Here is the drawing:\n```js\n" + A({"turn": -1, "starc": "#D2553A"}) + "\n```\nEnjoy.",
            "forever": "function draw(ctx,t){while(true){}}",
            "boom": "function draw(ctx,t){ctx.arc(0,0,size,0,7);ctx.fill()}",
            "default": A({"pts": 4, "skip": 1}),
        })

        names = ["Ana", "Marc", "Liam", "Sofia", "Jordi", "Mei"]
        ph = dict(zip(names, open_phones(ctx, svc, phone_src, names, CODE, errors=errs)))
        wait(sc, "document.getElementById('n') && TESSERA_GAME.players.length === 6", "6 players in the roster")
        check(len(G.players) == 6 and sorted(p_["name"] for p_ in G.players.values()) == sorted(names),
              "six phones joined by themselves with their names (requireName)")
        check(G.accept == {"moves": ["p*"]} and G.state.get("ph") == "brief", f"brief: phones open ({G.accept}, {G.state})")
        shot("00-brief")

        def send(name, text, expect="On the wall"):
            pg = ph[name]
            pg.fill("#say", text)
            pg.click("#send")
            return wait(pg, f"document.getElementById('status').textContent.includes({json.dumps(expect)})",
                        f"{name}: '{text[:30]}' -> {expect}", timeout=12000)

        plays = {
            "Ana": ["Dots on a star inside a ring", "Make the corners ease and add the green pulse", "Now do it exactly like the target"],
            "Marc": ["A rotating square", "A square that turns, dark outline"],
            "Liam": ["Six dots on a star", "Show it with a fence please", "Add a green pulse twice a loop"],
            "Sofia": ["A circle of dots", "Make it loop forever"],
            "Jordi": ["Make it boom"],
            "Mei": ["A star with six dots", "A star with six dots", "Green pulse please"],
        }
        for turn in range(3):
            for n, said in plays.items():
                if turn < len(said):
                    send(n, said[turn])
        calls = [c for c in svc.ai_calls if c["task"] == "draw"]
        check(len(calls) == sum(len(v) for v in plays.values()), f"one AI call per prompt ({len(calls)})")
        check(all(c["system"] == task["system"] for c in calls), "every call used the declared task's system prompt (the phone sends none)")
        check(calls[0]["input"].startswith("The student describes the animation") and
              any(c["input"].startswith("The current code") for c in calls), "later turns send the current code with the new words")
        mv = {(m_["pid"], m_["k"]): m_["data"] for m_ in G.moves}
        pid = {n: ph[n].tessera_pid for n in names}
        check(all((pid[n], f"p{k + 1}") in mv for n in names for k in range(len(plays[n]))), "each prompt is a move p<n>")
        check(all(len(json.dumps(d)) < 4000 for d in mv.values()), "every move's data is under 4 000 chars")
        check(mv[(pid["Liam"], "p2")]["js"].startswith("function draw") and "```" not in mv[(pid["Liam"], "p2")]["js"],
              "a fenced reply with prose around it is cut down to the function")
        wait(ph["Sofia"], "document.getElementById('errText').textContent.includes('never finished')", "Sofia's hanging drawing is stopped on her phone")
        wait(ph["Jordi"], "document.getElementById('errText').textContent.includes('size')", "Jordi's phone shows the real error")
        shot("01-phone-ana", ph["Ana"]); shot("01-phone-sofia", ph["Sofia"])

        # ── the wall (state 1): closest first
        sc.mouse.click(640, 705)
        wait(sc, "i === 1 && TESSERA_GAME.state && TESSERA_GAME.state.ph === 'wall'", "state 1 published")
        wait(sc, f"TESSERA_GAME.moves.length === {len(G.moves)} && entries.length === 7 && !busy && !queue.length"
             " && entries.every(e => e.status !== 'wait')", "the screen has every move and has scored every drawing", timeout=12000)
        sc.wait_for_timeout(1200)
        order = sc.evaluate("""[...entries].filter(e=>!e.isTarget).map(e=>({n:nameOf(e.pid),s:e.score,st:e.status,
            y:parseFloat(e.el.style.top),x:parseFloat(e.el.style.left)})).sort((a,b)=>a.y-b.y||a.x-b.x)""")
        scores = [o["s"] for o in order]
        check(order[0]["n"] == "Ana" and order[0]["s"] == 100, f"the wall: Ana (the target, 100) first: {[(o['n'], o['s']) for o in order]}")
        check(scores == sorted(scores, reverse=True), "the wall reads closest first")
        st = {o["n"]: o["st"] for o in order}
        check(st["Sofia"] == "bad" and st["Jordi"] == "bad", "the hang and the throw are error tiles on the wall, the screen unharmed")
        shot("02-wall")

        # ── The prompts (state 2): every prompt per student, in order
        sc.mouse.click(640, 705)
        wait(sc, "i === 2 && document.getElementById('prompts').classList.contains('on')", "state 2: The prompts")
        sc.wait_for_timeout(1500)
        cards = sc.evaluate("[...document.querySelectorAll('#plist .card')].map(c=>({n:c.querySelector('b span').textContent,"
                            "p:[...c.querySelectorAll('.hist li span')].map(s=>s.textContent)}))")
        got = {c["n"]: c["p"] for c in cards}
        want = {n: [t for k, t in enumerate(v) if not k or t != v[k - 1]] for n, v in plays.items()}
        check(got == want, f"every prompt of every student, in order, a repeat shown once: {got}")
        check([c["n"] for c in cards][0] == "Ana", "the cards are closest first")
        shot("03-prompts")
        sc.evaluate("auto=false")
        sc.mouse.move(600, 400); sc.mouse.wheel(0, 300); sc.wait_for_timeout(700)
        s1 = sc.evaluate("document.getElementById('plist').scrollTop")
        sc.mouse.click(1186, 166 + 88); sc.wait_for_timeout(900)
        s2 = sc.evaluate("document.getElementById('plist').scrollTop")
        sc.mouse.click(1186, 166); sc.wait_for_timeout(900)
        sc.mouse.move(600, 600); sc.mouse.down(); sc.mouse.move(600, 500, steps=5); sc.mouse.move(600, 350, steps=5); sc.mouse.up()
        sc.wait_for_timeout(400)
        s3 = sc.evaluate("document.getElementById('plist').scrollTop")
        sc.keyboard.press("ArrowDown"); sc.wait_for_timeout(600)
        check(sc.evaluate("i") == 2 and s1 > 0 and s2 > s1 and s3 > 0,
              f"wheel, the arrow buttons, a drag and ArrowDown scroll the list and never step the slide ({s1}, {s2}, {s3})")
        sc.evaluate("document.getElementById('plist').scrollTop=0")

        # ── the ranking (state 3) closes the phones
        sc.mouse.click(640, 705)
        wait(sc, "i === 3", "state 3: ranked")
        sc.wait_for_timeout(600)
        check(G.accept == {"moves": []} and G.state.get("ph") == "rank" and G.state.get("open") is False,
              f"the ranking closes the phones ({G.accept})")
        wait(ph["Liam"], "document.getElementById('shut').classList.contains('on') && document.getElementById('say').disabled",
             "Liam's phone says the phones are closed")
        before = (len(svc.ai_calls), len(G.moves))
        ph["Liam"].evaluate("document.getElementById('say').disabled=false")
        ph["Liam"].fill("#say", "One more try")
        ph["Liam"].evaluate("send()")
        ph["Liam"].wait_for_timeout(800)
        check((len(svc.ai_calls), len(G.moves)) == before, "a prompt while closed: no AI call spent, no move stored")
        r = svc.dispatch("POST", f"{svc.origin}/api/game", {"x-tessera-player": ph["Liam"].tessera_token},
                         {"code": CODE, "op": "move", "k": "p9", "data": {"p": "late", "js": ""}})
        check(r[0] == 403 and r[1].get("closed"), "the server itself refuses a late move (403 closed)")
        wait(ph["Ana"], "document.getElementById('place').classList.contains('on') && document.getElementById('placeN').textContent.startsWith('#1')",
             "Ana's phone shows her own place, #1")
        check(G.private.get(pid["Ana"], {}).get("rank") == 1 and pid["Sofia"] not in G.private,
              "private: Ana rank 1; Sofia (no drawing that runs) none")
        shot("04-rank"); shot("04-phone-place", ph["Ana"])
        sc.mouse.click(640, 705)
        wait(sc, "i === 4 && document.getElementById('capH').classList.contains('on')", "state 4: the podium's last place")
        shot("05-podium")

        # ── a phone reload: same player, history back
        ph["Liam"].reload()
        wait(ph["Liam"], "document.querySelectorAll('#hl li').length === 3 && document.getElementById('turn').textContent === 'Turn 4'",
             "Liam reloaded: his three prompts are back, next turn 4")
        wait(ph["Liam"], "typeof shown === 'string' && shown.startsWith('function draw')", "Liam's last drawing is back")
        check(len(G.players) == 6, "a reload is the same player")
        shot("06-phone-reloaded", ph["Liam"])

        # ── a screen reload resumes; a second screen follows
        sc.reload()
        wait(sc, "i === 4 && entries.length === 7", "the reloaded screen resumes at state 4 with every entry")
        sc2 = open_screen(ctx, svc, screen_src, CODE, path="/screen2.html")
        wait(sc2, "i === 4 && entries.length === 7 && entries.every(e => e.status !== 'wait')", "a second screen opens at state 4")
        sc2.wait_for_timeout(1500)                       # its first publish (the private places) has landed
        sc.keyboard.press("ArrowLeft"); sc.keyboard.press("ArrowLeft"); sc.keyboard.press("ArrowLeft")
        wait(sc2, "i === 1", "the second screen follows to the wall")
        wait(sc, "TESSERA_GAME.state.s === 1", "the first screen's last state stored")
        check(G.accept == {"moves": ["p*"]}, "back on the wall: the phones reopen")
        sc2.mouse.click(640, 705)
        wait(sc, "i === 2", "a step on the second screen: the first follows")
        sc2.close()
        sc.keyboard.press("ArrowLeft")
        wait(sc, "i === 1 && TESSERA_GAME.state.s === 1", "back to the wall")

        # ── the Phones button
        sc.click("#open"); sc.wait_for_timeout(500)
        wait(sc, "TESSERA_GAME.accept && TESSERA_GAME.accept.moves.length === 0", "Phones button: closed")
        check(sc.evaluate("i") == 1, "the button does not step the slide")
        sc.click("#open")
        wait(sc, "TESSERA_GAME.accept && TESSERA_GAME.accept.moves[0] === 'p*'", "Phones button: open again")
        send("Marc", "Now a square exactly like the target", "On the wall: version 3")

        # ── Remove a player from the wall
        box = sc.evaluate("(()=>{const e=entries.find(e=>!e.isTarget&&nameOf(e.pid)==='Mei');const r=e.el.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        sc.mouse.click(*box)
        wait(sc, "picked && nameOf(picked.pid) === 'Mei' && document.getElementById('hqt').children.length === 2", "a picked tile shows its prompts")
        sc.wait_for_timeout(1200)
        shot("07-picked")
        sc.click("#kick"); sc.click("#kick")
        wait(sc, "!picked && entries.filter(e=>!e.isTarget&&isLive(e.pid)).length === 5", "Mei is off the wall")
        check(G.players[pid["Mei"]]["kicked"], "Remove: kicked on the server")
        wait(ph["Mei"], "document.getElementById('gone').classList.contains('on')", "Mei's phone says she was taken off")

        # ── reset
        sc.click("#reset"); sc.click("#reset")
        wait(sc, "TESSERA_GAME.players.length === 6 && entries.length === 1 && i === 0", "after reset: no entries, brief, phones rejoin", timeout=12000)
        check(not G.moves and not G.private and G.accept == {"moves": ["p*"]}, f"reset: no moves, no private, open ({len(G.moves)} moves)")
        wait(ph["Ana"], "document.querySelectorAll('#hl li').length === 0 && document.getElementById('turn').textContent === 'Turn 1'",
             "Ana's phone history is gone after the reset")
        check(not G.players[pid["Mei"]]["kicked"], "after a reset Mei is back in")
        send("Ana", "A star again")
        shot("08-after-reset")

        # ── no key
        nk = open_screen(ctx, svc, screen_src, CODE, path="/nokey.html", key="")
        wait(nk, "document.getElementById('note').textContent.includes('lecturer key')", "no key: the screen says so")
        check(nk.locator("#reset").is_disabled() and nk.locator("#open").is_disabled(), "no key: the controls are disabled")
        check(not errs, "no page errors " + "; ".join(errs))
        br.close()
    print(f"\nscreenshots: {out}")
    print("ALL OK" if not fails else f"{len(fails)} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
