"""Rehearse the starter game (kit/engage/game-screen.html + game-phone.html) offline.

    python tools/rehearse_starter.py [--screen S.html --phone P.html] [--out DIR]

The screen and four phones against mock_service.py (never the real service),
with the game SDK injected as the deck and the join page do. Plays the lobby
(auto-join, a kick), a round (votes that change, a buzzer race, a closed round),
the reveal (each phone's private result, the bars), the leaderboard, the other
rounds, a phone and a screen reload mid-game, Back, the final standings, Reset
(phones rejoin by themselves) and a screen without the lecturer key. It is also
the worked example of a game rehearsal: copy it next to a game's pages and
change the plays. Screenshots in --out (default: tessera-rehearse-starter in the
system temp folder, never next to the assets).
"""
import argparse
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ASSETS = HERE.parent / "kit" / "engage"      # the pages
from mock_service import MockService, open_phones, open_screen  # noqa: E402
from shoot import find_chrome  # noqa: E402

CODE = "k7m3pq"
fails = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        fails.append(what)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--screen", default=str(ASSETS / "game-screen.html"))
    ap.add_argument("--phone", default=str(ASSETS / "game-phone.html"))
    ap.add_argument("--out", default=str(pathlib.Path(tempfile.gettempdir()) / "tessera-rehearse-starter"))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    screen_src = pathlib.Path(a.screen).read_text(encoding="utf-8")
    phone_src = pathlib.Path(a.phone).read_text(encoding="utf-8")
    svc = MockService()
    svc.sdk_source()                          # fails clearly when the SDK is missing
    from playwright.sync_api import sync_playwright
    errs = []
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=find_chrome())
        ctx = br.new_context()
        svc.attach(ctx)
        sc = open_screen(ctx, svc, screen_src, CODE, errors=errs)
        names = ["Ana", "Marc", "Liam", "Sofia"]
        ph = dict(zip(names, open_phones(ctx, svc, phone_src, names, CODE, errors=errs)))
        G = svc.game(CODE)

        def wait(page, js, what, timeout=7000):
            try:
                page.wait_for_function(js, timeout=timeout)
                return True
            except Exception:
                check(False, f"timed out: {what}")
                return False

        def text(page, sel="body"):
            return page.inner_text(sel)

        def shot(name, page=None):
            (page or sc).screenshot(path=str(out / f"{name}.png"), full_page=page is not None)

        # ── lobby
        wait(sc, "document.querySelectorAll('#names .chip').length === 4", "4 names on the screen")
        check(len(G.players) == 4 and all(p["name"] in names for p in G.players.values()),
              "the four phones joined by themselves with their names")
        check("You're in, Ana" in text(ph["Ana"]), "Ana's phone: you're in")
        shot("00-lobby"); shot("00-phone-lobby", ph["Ana"])
        sc.click("#names .chip:has-text('Sofia')")
        wait(ph["Sofia"], "document.body.innerText.includes('removed')", "Sofia's phone told she was removed")
        check(G.players[ph["Sofia"].tessera_pid]["kicked"], "click a name: kicked on the server")

        # ── round 1
        sc.click("#next")
        wait(ph["Ana"], "document.querySelectorAll('.opt').length === 4", "round 1 on the phones")
        R0 = json.loads(json.dumps(G.state))
        check(R0.get("phase") == "question" and "answer" not in json.dumps(R0) and G.accept == {"moves": ["v0", "b0"]},
              "the question is in the state, the right answer is not; accept takes v0 and b0")
        ph["Ana"].click(".opt[data-i='1']")
        ph["Marc"].click(".opt[data-i='0']")
        ph["Liam"].click(".opt[data-i='2']")
        ph["Ana"].click("#buzz")
        wait(ph["Ana"], "document.body.innerText.includes('You were first')", "Ana buzzed first")
        ph["Marc"].click("#buzz")
        wait(ph["Marc"], "document.body.innerText.includes('Too late')", "Marc told too late")
        ph["Marc"].click(".opt[data-i='1']")               # changes his mind
        wait(sc, "document.getElementById('voted').textContent.startsWith('3')", "screen: 3 voted")
        check([m["data"] for m in G.moves if m["k"] == "v0" and m["pid"] == ph["Marc"].tessera_pid] == [1],
              "Marc's changed vote replaced the first (mode last)")
        check("Ana" in text(sc, "#buzz"), "screen: Ana first on the buzzer")
        shot("01-question"); shot("01-phone-question", ph["Marc"])
        sc.click("#next")                                  # close voting
        wait(ph["Liam"], "document.querySelector('.opt') && document.querySelector('.opt').disabled", "phones locked")
        check(G.accept == {"moves": []}, "closed: accept takes no moves")
        # ── reveal
        sc.click("#next")
        wait(ph["Ana"], "document.body.innerText.includes('Right!')", "Ana's private result")
        priv = {n: G.private.get(ph[n].tessera_pid) for n in names}
        check(priv["Ana"]["delta"] == 3 and priv["Marc"]["delta"] == 1 and priv["Liam"]["delta"] == 0 and priv["Sofia"] is None,
              f"private: Ana +3 (right + buzz), Marc +1, Liam 0, Sofia (kicked) none: {[(n, (priv[n] or {}).get('delta')) for n in names]}")
        check(priv["Ana"]["rank"] == 1 and priv["Marc"]["rank"] == 2 and priv["Liam"]["rank"] == 3, "ranks 1, 2, 3")
        wait(ph["Liam"], "document.body.innerText.includes('Not this time')", "Liam's phone: not this time")
        check("+3" not in text(ph["Liam"]) and "Ana" not in text(ph["Liam"], "#view"), "Liam's phone shows only his own result")
        wait(sc, "document.querySelector('.opt.right .n') && document.querySelector('.opt.right .n').textContent === '2'",
             "screen: the right option has 2 votes")
        shot("02-reveal"); shot("02-phone-reveal", ph["Ana"])
        # ── a phone reloads mid-game: same player
        ph["Marc"].reload()
        wait(ph["Marc"], "document.body.innerText.includes('Total')", "Marc reloaded: still in, his result back")
        check(len(G.players) == 4, "a reload is the same player (no new pid)")
        # ── leaderboard
        sc.click("#next")
        wait(sc, "document.querySelectorAll('#rows .row').length === 3", "leaderboard rows")
        order = [t.strip() for t in sc.locator("#rows .row .nm").all_inner_texts()]
        check(order == ["Ana", "Marc", "Liam"], f"leaderboard order {order}")
        shot("03-board")
        # ── the screen reloads: the game resumes
        sc.reload()
        wait(sc, "document.querySelectorAll('#rows .row').length === 3", "reloaded screen resumes at the leaderboard")
        # ── Back and forward again keeps the scores
        sc.click("#back")
        wait(sc, "document.getElementById('question').classList.contains('revealed')", "Back: the reveal again")
        sc.click("#next")
        wait(sc, "document.querySelectorAll('#rows .row').length === 3", "forward again")
        check(G.state["scores"][ph["Ana"].tessera_pid] == 3, "Back + forward did not count the round twice")
        # ── rounds 2 and 3
        for r in (1, 2):
            sc.click("#next")
            wait(ph["Liam"], f"document.getElementById('round') && document.getElementById('round').textContent.includes('Round {r + 1}')",
                 f"round {r + 1} on the phones")
            ans = sc.evaluate(f"CONFIG.rounds[{r}].answer")
            ph["Liam"].click(f".opt[data-i='{ans}']")
            ph["Ana"].click(f".opt[data-i='{(ans + 1) % 4}']")
            ph["Ana"].click("#buzz")
            wait(ph["Ana"], "document.body.innerText.includes('You were first')", f"round {r + 1}: Ana buzzes")
            wait(sc, "document.getElementById('voted').textContent.startsWith('2')", f"round {r + 1}: 2 voted")
            sc.click("#next"); sc.wait_for_timeout(300)
            sc.click("#next")
            wait(ph["Liam"], "document.body.innerText.includes('Right!')", f"round {r + 1}: Liam right")
            sc.click("#next")
            wait(sc, "document.getElementById('board').classList.contains('on')", f"round {r + 1}: board")
        check("Final" in text(sc, "#boardHead") and sc.inner_text("#next") == "Play again", "after the last round: final standings")
        totals = {n: G.state["scores"].get(ph[n].tessera_pid) for n in ("Ana", "Marc", "Liam")}
        check(totals == {"Ana": 3 + 2 * (0 - 1), "Marc": 1, "Liam": 2}, f"final totals {totals}")
        wait(ph["Liam"], "document.body.innerText.includes('Final place')", "phones show their final place")
        shot("04-final"); shot("04-phone-final", ph["Liam"])
        # ── reset
        sc.click("#reset"); sc.click("#reset")
        wait(sc, "document.querySelectorAll('#names .chip').length === 4", "after reset the phones rejoin", timeout=9000)
        check(G.state.get("phase", "lobby") == "lobby" and not G.moves and not G.private,
              f"reset: lobby, no moves, no private ({G.state}, {len(G.moves)} moves, {len(G.private)} private)")
        check(not G.players[ph["Sofia"].tessera_pid]["kicked"], "after a reset Sofia (kicked before) is back in")
        # ── two quick clicks: the second builds on the first before any read
        sc.click("#next"); sc.click("#next")
        wait(sc, "document.getElementById('closed').textContent.includes('closed')", "two quick clicks: open, then closed")
        check(G.state.get("phase") == "closed" and G.state.get("r") == 0 and "changed the game" not in sc.inner_text("#status"),
              f"two quick clicks land in order, no stale write ({G.state.get('phase')})")
        # ── no key
        nk = open_screen(ctx, svc, screen_src, CODE, path="/nokey.html", key="")
        wait(nk, "document.getElementById('status').textContent.includes('lecturer key')", "no key: the screen says so")
        check(nk.locator("#next").is_disabled(), "no key: the controls are disabled")
        check(not errs, "no page errors " + "; ".join(errs))
        br.close()
    print(f"\nscreenshots: {out}")
    print("ALL OK" if not fails else f"{len(fails)} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
