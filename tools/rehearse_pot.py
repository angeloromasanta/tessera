"""Rehearse the group pot (kit/engage/pot-screen.html + pot-phone.html) offline.

    python tools/rehearse_pot.py [--screen S.html --phone P.html] [--out DIR]

The screen and eight phones against mock_service.py (never the real service, never
the lecturer key from .env), with the game SDK injected as the deck and the join
page do. Game 1, teams picked on the phones: setup (phones join by themselves),
registration (picks, a changed pick, a removed player who is refused afterwards),
round 1, Show results (the round closes: a late move is refused), each phone's
private numbers checked against the payoff formula, round 2 with changed
contributions and a player who sends nothing, a phone reload and a screen reload
mid-round (same player, same state, no write), a second screen that takes over and
the first that follows, Reset scores in the results and during a round (the old
ballot is refused). Reset game: phones rejoin. Game 2, randomized teams and all or
nothing: balanced teams, one team refunded, one paid exactly at half. Then a screen
without the key. Screenshots in --out (default: tessera-rehearse-pot in the system
temp folder).
"""
import argparse
import json
import math
import pathlib
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ASSETS = HERE.parent / "kit" / "engage"      # the pages
from mock_service import MockService, open_phones, open_screen  # noqa: E402
from shoot import find_chrome  # noqa: E402

CODE = "p7tq4m"
INIT, MULT = 20, 2
fails = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        fails.append(what)


def f1(x):                      # the pages' f1: Math.round(x * 10) / 10, toFixed(1)
    return f"{math.floor(x * 10 + 0.5) / 10:.1f}"


def settle(pts, team, contrib, mult, aon):
    """The original showResults (plus all or nothing): pts and team are pid -> value for
    every member; contrib pid -> what the phone sent (absent = 0). Returns pid -> private."""
    pots, size, cap, cs = {}, {}, {}, {}
    for pid, t in team.items():
        mx = math.floor(pts[pid] + 1e-9)
        c = max(0, min(mx, contrib.get(pid, 0)))
        cs[pid] = c
        pots[t] = pots.get(t, 0) + c
        size[t] = size.get(t, 0) + 1
        cap[t] = cap.get(t, 0) + mx
    paid = {t: (not aon) or pots[t] >= cap[t] / 2 for t in pots}
    out, n = {}, len(team)
    cls = sum(cs.values()) / n
    for pid, t in team.items():
        c = cs[pid]
        if paid[t]:
            share = pots[t] * mult / size[t]
            lr, p = share - c, pts[pid] - c + share
        else:
            lr, p = 0, pts[pid]
        mates = [cs[q] for q, u in team.items() if u == t and q != pid]
        out[pid] = {"t": t, "p": p, "lc": c, "lr": lr, "mate": sum(mates) / len(mates) if mates else None,
                    "cls": cls, "pot": pots[t], "paid": paid[t]}
    return out


def same_priv(got, want):
    if not got:
        return False
    for k, v in want.items():
        g = got.get(k)
        if isinstance(v, float) or isinstance(g, float):
            if g is None or v is None or abs(g - v) > 1e-9:
                return False
        elif g != v:
            return False
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--screen", default=str(ASSETS / "pot-screen.html"))
    ap.add_argument("--phone", default=str(ASSETS / "pot-phone.html"))
    ap.add_argument("--out", default=str(pathlib.Path(tempfile.gettempdir()) / "tessera-rehearse-pot"))
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    screen_src = pathlib.Path(a.screen).read_text(encoding="utf-8")
    phone_src = pathlib.Path(a.phone).read_text(encoding="utf-8")
    svc = MockService()
    svc.sdk_source()
    from playwright.sync_api import sync_playwright
    errs = []
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=find_chrome())
        ctx = br.new_context()
        ctx.add_init_script("window.POT_TICK = 400")
        svc.attach(ctx)
        sc = open_screen(ctx, svc, screen_src, CODE, errors=errs)
        names = ["Ana", "Marc", "Liam", "Sofia", "Jordi", "Mei", "Omar", "Eva"]
        ph = dict(zip(names, open_phones(ctx, svc, phone_src, names, CODE, errors=errs)))
        pid = {n: ph[n].tessera_pid for n in names}
        G = svc.game(CODE)
        pump = [sc]

        def until(pred, what, timeout=9.0):
            t = time.time() + timeout
            while time.time() < t:
                try:
                    if pred():
                        check(True, what)
                        return True
                except Exception:
                    pass
                pump[0].wait_for_timeout(50)
            check(False, f"timed out: {what}")
            return False

        def body(page):
            return page.inner_text("body")

        def shot(name, page=None):
            (page or sc).screenshot(path=str(out / f"{name}.png"), full_page=page is not None)

        def priv(n):
            return G.private.get(pid[n])

        def move(n, k, data):        # a phone's move straight to the service (what a late phone would send)
            return svc.dispatch("POST", svc.origin + "/api/game", {"x-tessera-player": ph[n].tessera_token},
                                {"code": CODE, "op": "move", "k": k, "data": data})

        def give(n, c):
            ph[n].wait_for_selector("#r-form", state="visible", timeout=9000)
            ph[n].evaluate("v => { const s = document.getElementById('r-s'); s.value = v; s.dispatchEvent(new Event('input')); }", c)
            ph[n].click("#send")

        def state_is_public():
            st = G.state
            okk = set(st) <= {"ph", "round", "b", "lock", "set", "log", "by"}
            kinds = {e[0] for e in st.get("log", [])}
            floats = [x for e in st.get("log", []) for x in e if isinstance(x, float)]
            return okk and kinds <= {"p", "x", "z", "r"} and not floats

        # ── setup: the phones join by themselves; the screen publishes the setup and closes moves
        until(lambda: len(G.players) == 8, "8 phones joined in setup")
        until(lambda: G.state.get("ph") == "setup" and G.accept == {"moves": []}, "screen published setup, accept takes no move")
        check("Set up the game" in sc.inner_text("#title"), "screen: Set up the game")
        until(lambda: "Please wait for the game to start" in body(ph["Ana"]), "phone: please wait")
        check(move("Ana", "c1", 5)[0] == 403, "setup: a contribution is refused")
        shot("00-setup"); shot("00-phone-setup", ph["Ana"])

        # ── registration, teams picked on the phones
        sc.click("#go")
        until(lambda: G.state.get("ph") == "registration" and G.accept == {"moves": ["team"]}, "registration, accept team")
        picks = {"Ana": 1, "Marc": 1, "Liam": 2, "Sofia": 2, "Jordi": 3, "Mei": 3, "Omar": 1, "Eva": 2}
        for n, t in picks.items():
            ph[n].wait_for_selector("#team", state="visible", timeout=9000)
            ph[n].select_option("#team", str(t))
            ph[n].click("#go")
        until(lambda: all((priv(n) or {}).get("t") == t for n, t in picks.items()), "8 placed in their picked teams")
        until(lambda: "You are in Team 1" in body(ph["Ana"]), "Ana's phone: waiting, Team 1")
        until(lambda: len(sc.query_selector_all("#teams .pl")) == 8, "screen: 8 names in the team cards")
        shot("01-registration")
        ph["Omar"].click("#w-chg")                      # a wrong pick, changed during registration
        ph["Omar"].wait_for_selector("#team", state="visible", timeout=9000)
        ph["Omar"].select_option("#team", "3")
        ph["Omar"].click("#go")
        until(lambda: (priv("Omar") or {}).get("t") == 3, "Omar changed to Team 3")
        sc.click(f".pl[data-pid='{pid['Eva']}'] .x")    # remove a player
        until(lambda: G.players[pid["Eva"]]["kicked"], "Eva kicked on the server")
        until(lambda: priv("Eva") is None and any(e[0] == "x" and e[1] == pid["Eva"] for e in G.state["log"]),
              "Eva's record gone (log x, private cleared)")
        until(lambda: "removed you" in body(ph["Eva"]), "Eva's phone: removed")
        until(lambda: not sc.query_selector(f".pl[data-pid='{pid['Eva']}']"), "screen: Eva's row gone")
        shot("01-phone-removed", ph["Eva"])
        team = {pid[n]: (3 if n == "Omar" else picks[n]) for n in names if n != "Eva"}
        pts = {q: float(INIT) for q in team}

        # ── round 1
        sc.click("#go")
        until(lambda: G.state.get("ph") == "voting" and G.accept == {"moves": ["team", "c1"]}, "round 1 open: accept c1")
        check(move("Eva", "c1", 3)[0] == 403, "a removed player's move is refused")
        c1 = {"Ana": 10, "Marc": 0, "Liam": 5, "Sofia": 20, "Jordi": 3, "Mei": 7, "Omar": 1}
        for n, c in c1.items():
            give(n, c)
        until(lambda: sc.inner_text("#info").startswith("7 of 7"), "screen: 7 of 7 sent")
        until(lambda: "Points sent" in body(ph["Mei"]), "Mei's phone: points sent")
        check(len(sc.query_selector_all("#teams .pl.yes")) == 7, "screen: every row green")
        check(state_is_public(), f"the public state has no points: {sorted(G.state)}")
        shot("02-round1"); shot("02-phone-round1", ph["Ana"])
        sc.click("#go")                                  # Show results
        until(lambda: G.state.get("ph") == "results", "round 1 results")
        check(G.accept == {"moves": ["team"]}, "results: accept closes the round")
        st, body_ = move("Ana", "c1", 2)
        check(st == 403 and body_.get("closed"), f"a late move to the closed round is refused ({st} {body_})")
        exp = settle(pts, team, {pid[n]: c for n, c in c1.items()}, MULT, False)
        until(lambda: all(same_priv(G.private.get(q), exp[q]) for q in team), "round 1: every private matches the formula")
        for q in team:
            if not same_priv(G.private.get(q), exp[q]):
                print("   ", q, G.private.get(q), exp[q])
        until(lambda: f"Round change: +{f1(exp[pid['Marc']]['lr'])} points" in body(ph["Marc"]), "Marc's phone: his round change")
        lr_ana = exp[pid["Ana"]]["lr"]
        until(lambda: f"Round change: {'+' if lr_ana >= 0 else ''}{f1(lr_ana)}" in body(ph["Ana"]), "Ana's phone: her round change")
        check("Marc" not in body(ph["Liam"]) and "Ana" not in body(ph["Liam"]), "Liam's phone shows no one else")
        check(f1(exp[pid["Ana"]]["p"]) + " pts" in body(ph["Ana"]), "Ana's phone: her money")
        check(f"Pot: {f1(exp[pid['Ana']]['pot'])}" in sc.inner_text("#teams"), "screen: team pots in the headers")
        shot("03-results1"); shot("03-phone-results1", ph["Marc"])
        pts = {q: exp[q]["p"] for q in team}

        # ── round 2: changed contributions, Omar sends nothing (still counts in his team's size)
        sc.click("#go")
        until(lambda: G.state.get("ph") == "voting" and G.state.get("b") == 2 and G.accept == {"moves": ["team", "c2"]},
              "round 2 open: accept c2")
        want2 = {"Ana": 0, "Marc": 12, "Liam": 15, "Sofia": 5, "Jordi": 10, "Mei": 0}
        c2 = {n: min(c, math.floor(pts[pid[n]] + 1e-9)) for n, c in want2.items()}
        for n, c in c2.items():
            give(n, c)
        until(lambda: sc.inner_text("#info").startswith("6 of 7"), "screen: 6 of 7 sent")
        ph["Liam"].reload()                              # a phone reloads mid-round
        until(lambda: "Points sent" in body(ph["Liam"]), "Liam reloaded: still sent, same player")
        check(len(G.players) == 8, "a phone reload is the same player")
        v0 = G.v
        sc.reload()                                      # the screen reloads mid-round
        until(lambda: sc.inner_text("#info").startswith("6 of 7"), "reloaded screen resumes round 2 (6 of 7 sent)")
        sc.wait_for_timeout(1500)
        check(G.v == v0, f"a reloaded screen does not rewrite the state (v {v0} -> {G.v})")
        shot("04-round2-reloaded")
        sc2 = open_screen(ctx, svc, screen_src, CODE, path="/screen2.html", errors=errs)   # a second screen takes over
        until(lambda: sc2.inner_text("#info").startswith("6 of 7"), "second screen shows round 2")
        sc2.click("#go")
        until(lambda: G.state.get("ph") == "results" and G.state.get("round") == 2, "second screen: round 2 results")
        until(lambda: "Round 2 results" in sc.inner_text("#title"), "the first screen follows the second")
        exp = settle(pts, team, {pid[n]: c for n, c in c2.items()}, MULT, False)
        until(lambda: all(same_priv(G.private.get(q), exp[q]) for q in team), "round 2: every private matches the formula")
        check(exp[pid["Omar"]]["lc"] == 0 and exp[pid["Omar"]]["lr"] > 0, "Omar sent nothing and still got his share")
        check(G.private[pid["Omar"]]["lc"] == 0, "Omar's contribution counts as 0")
        until(lambda: f"{f1(exp[pid['Omar']]['p'])} pts" in body(ph["Omar"]), "Omar's phone: his money")
        sc2.close()
        shot("05-results2"); shot("05-phone-results2", ph["Omar"])
        sc.click("#view button[data-v='money']")
        sc.wait_for_timeout(300)
        ranks = [t.strip() for t in sc.locator("#money .pl .nm").all_inner_texts()]
        best = max(team, key=lambda q: exp[q]["p"])
        check(len(ranks) == 7 and ranks[0] == next(n for n in names if pid[n] == best), f"By money ranks the richest first {ranks[:3]}")
        shot("05-by-money")
        sc.click("#view button[data-v='teams']")

        # ── Reset scores in the results, then during a round
        sc.click("#rscore")
        until(lambda: all(G.private[q]["p"] == INIT and G.private[q]["lr"] is None and G.private[q]["z"] == 1 for q in team),
              "Reset scores: everyone back to the initial points")
        until(lambda: "Scores were reset" in body(ph["Ana"]), "Ana's phone: scores were reset")
        sc.click("#go")                                  # round 3
        until(lambda: G.state.get("b") == 3 and G.state.get("ph") == "voting", "round 3 open")
        give("Ana", 4)
        until(lambda: "Points sent" in body(ph["Ana"]), "Ana sent in round 3")
        sc.click("#rscore")
        until(lambda: G.state.get("b") == 4 and G.accept == {"moves": ["team", "c4"]}, "Reset scores during a round: a new ballot")
        until(lambda: ph["Ana"].is_visible("#r-form"), "Ana's phone asks again")
        check(move("Ana", "c3", 4)[0] == 403, "the old ballot is refused")
        shot("06-reset-scores")

        # ── Reset game: everything goes, the phones rejoin by themselves (Eva too)
        sc.click("#rgame"); sc.click("#rgame")
        until(lambda: G.state.get("ph") == "setup" and G.state["set"]["hide"] is False and not G.moves, "Reset game: setup, no moves")
        until(lambda: len(G.players) == 8 and not any(p_["kicked"] for p_ in G.players.values()), "phones rejoined, Eva too")
        check(not G.private, "Reset game: no private values left")
        until(lambda: "Please wait for the game to start" in body(ph["Eva"]), "Eva's phone: please wait")

        # ── game 2: randomized teams, all or nothing
        sc.click("#c-rand")
        until(lambda: G.state["set"]["rand"] is True, "randomize on")
        sc.click("#c-aon")
        until(lambda: G.state["set"]["aon"] is True, "all or nothing on")
        shot("07-setup2")
        sc.click("#go")
        until(lambda: sum(1 for n in names if (priv(n) or {}).get("t")) == 8, "randomized: all 8 placed, nobody picked")
        team = {pid[n]: priv(n)["t"] for n in names}
        sizes = sorted(list(team.values()).count(t) for t in (1, 2, 3))
        check(sizes == [2, 3, 3], f"balanced teams {sizes}")
        until(lambda: "You are in Team" in body(ph["Eva"]), "Eva's phone: her team")
        shot("08-registration2")
        sc.click("#go")
        until(lambda: G.state.get("ph") == "voting", "game 2 round 1 open")
        by_t = {t: [n for n in names if team[pid[n]] == t] for t in (1, 2, 3)}
        three = [t for t in by_t if len(by_t[t]) == 3]
        two = [t for t in by_t if len(by_t[t]) == 2][0]
        plan = {}
        for n, c in zip(by_t[three[0]], (20, 10, 5)):    # 35 of 60: paid
            plan[n] = c
        for n, c in zip(by_t[three[1]], (2, 0, 0)):      # 2 of 60: refunded
            plan[n] = c
        for n, c in zip(by_t[two], (10, 10)):            # 20 of 40: exactly half, paid
            plan[n] = c
        for n, c in plan.items():
            give(n, c)
        until(lambda: sc.inner_text("#info").startswith("8 of 8"), "screen: 8 of 8 sent")
        sc.click("#go")
        until(lambda: G.state.get("ph") == "results", "game 2 results")
        pts = {q: float(INIT) for q in team}
        exp = settle(pts, team, {pid[n]: c for n, c in plan.items()}, MULT, True)
        until(lambda: all(same_priv(G.private.get(q), exp[q]) for q in team), "all or nothing: every private matches")
        loser = by_t[three[1]][0]
        check(not G.private[pid[loser]]["paid"] and G.private[pid[loser]]["p"] == INIT and G.private[pid[loser]]["lr"] == 0,
              "the team below half is refunded (points unchanged)")
        check(G.private[pid[by_t[two][0]]]["paid"] and G.private[pid[by_t[three[0]][0]]]["paid"], "the other two teams are paid (half is enough)")
        until(lambda: "did not reach half" in body(ph[loser]), f"{loser}'s phone: refunded")
        check("(refunded)" in sc.inner_text("#teams"), "screen: the refunded team's header says so")
        shot("09-aon"); shot("09-phone-refund", ph[loser])

        # ── a screen without the key
        nk = open_screen(ctx, svc, screen_src, CODE, path="/nokey.html", key="")
        until(lambda: "lecturer key" in nk.inner_text("#note"), "no key: the screen says so")
        until(lambda: "Round 1 results" in nk.inner_text("#title"), "no key: the public state still shows (round 1 results)")
        check(nk.locator("#go").is_disabled(), "no key: the controls are disabled")
        check("Enter the lecturer key" in nk.inner_text("#empty"), "no key: no roster shown")
        nk.screenshot(path=str(out / "10-nokey.png"))
        check(not errs, "no page errors " + "; ".join(errs))
        br.close()
    print(f"\nscreenshots: {out}")
    print("ALL OK" if not fails else f"{len(fails)} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
