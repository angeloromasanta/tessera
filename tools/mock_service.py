"""The poll service in memory, for rehearsing a game or a reading figure offline.

A Playwright `route` handler (sync API) that answers every request to a fake
origin (default http://t) the way server/poll-worker does: answers,
polls, sessions, the game layer (docs/game.md) and /api/ai with
canned replies, behind the lecturer key. Never touches the real service.

    import sys; sys.path.insert(0, "tools")
    from mock_service import MockService, open_screen, open_phones
    from playwright.sync_api import sync_playwright

    svc = MockService(ai={"judge": "Nice idea."})          # key: svc.key ("rehearsal-only")
    with sync_playwright() as p:
        ctx = p.chromium.launch().new_context()
        svc.attach(ctx)                                     # ctx.route(svc.origin + "/**", svc.handle)
        screen = open_screen(ctx, svc, SCREEN_HTML, code="k7m3pq")
        phones = open_phones(ctx, svc, PHONE_HTML, ["Ana", "Marc", "Liam"], code="k7m3pq")
        ...
        svc.game("k7m3pq").players                          # inspect the store directly

Pages: `open_screen` injects `window.TESSERA_EMBED` as the deck does (texts,
poll.service/session/lecturer/previous, a `text()` like EMBED_TEXT_BRIDGE's);
`open_phones` serves one activity page per phone with `window.TESSERA_ACTIVITY`
({code, name, player, limits}; `player` is that phone's device token, stable
across a reload). Both are also set under their old names (legacy.py), so a
page written before the rename runs too. A page carrying
`<meta name="tessera-game">` (or the old meta) also gets the game SDK
(slides/src/game-sdk.js, or $TESSERA_GAME_SDK) injected after that, as
render.ts and the join page do; if the SDK is not there, it fails with a clear
message. The service also serves /game.js and /lib/NAME.js. Requests may carry
the lecturer key and the player token under the new or the old header name.

    python mock_service.py --self-test        # the store's semantics, no browser, no SDK
    python mock_service.py --self-test --browser   # also through Playwright's route

Not mocked: /api/live (no socket: pages fall back to their timers), /api/draw,
/api/help, /api/remix, /api/cluster, /api/summarize (404).
"""
from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import sys
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import config  # noqa: E402
import legacy  # noqa: E402

REPO = config.REPO
SDK = REPO / "slides" / "src" / "game-sdk.js"
LIBS = REPO / "server" / "poll-worker" / "public" / "lib"
LECTURER_HEADERS = ("x-tessera-lecturer", legacy.LECTURER_HEADER)
PLAYER_HEADERS = ("x-tessera-player", legacy.PLAYER_HEADER)

# server/poll-worker/src/api/_lib.js and docs/game.md
CODE_RE = re.compile(r"^[a-z0-9]{4,12}$")
SESSION_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])$")
KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
PID_RE = re.compile(r"^[a-z2-7]{12}$")
MAX_ANSWER_CHARS, MAX_NAME_CHARS, MAX_ANSWERS = 2000, 60, 500
MAX_ACTIVITY_HTML_CHARS = 60_000
MAX_PLAYERS, MAX_MOVES, MAX_MOVE_CHARS = 500, 10_000, 4_000
MAX_STATE_CHARS, MAX_PRIVATE_CHARS, MAX_MOVES_PER_READ = 100_000, 4_000, 2_000
MAX_AI_INPUT, MAX_AI_SYSTEM, MAX_AI_TOKENS = 4_000, 8_000, 1_500
AI_OPEN_HOURS = 3
GAME_META = re.compile(r"<meta[^>]+name=[\"']?(?:tessera-game|" + re.escape(legacy.GAME_META) + r")\b", re.I)
AI_TASKS = re.compile(r'<script[^>]+id=["\']?(?:tessera-ai|' + re.escape(getattr(legacy, "AI_TAG", legacy.GAME_META.replace("-game", "-ai")))
                      + r')["\']?[^>]*>(.*?)</script>', re.S | re.I)
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": ", ".join(("content-type",) + LECTURER_HEADERS + PLAYER_HEADERS),
}


def header(h: dict, names) -> str:
    """The first of these (lower-cased) headers that is set."""
    return next((h[n] for n in names if h.get(n)), "")
QR_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" width="290" height="290">'
          '<rect width="29" height="29" fill="#fff"/><path d="M1 1h7v7H1zM21 1h7v7h-7zM1 21h7v7H1z'
          'M11 11h7v7h-7z" fill="#{fg}"/></svg>')


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int | None = None) -> str:
    t = datetime.datetime.fromtimestamp((ms or now_ms()) / 1000, datetime.timezone.utc)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pid_of(code: str, token: str) -> str:
    """The public player id: first 12 chars of base32(sha256('CODE:TOKEN')), lower case."""
    return base64.b32encode(hashlib.sha256(f"{code}:{token}".encode()).digest()).decode().lower()[:12]


def device_token(seed: str | None = None) -> str:
    """What the join page keeps in localStorage (`tessera-device`): 24 url-safe chars."""
    if seed is None:
        return secrets.token_urlsafe(18)[:24]
    return base64.urlsafe_b64encode(hashlib.sha256(seed.encode()).digest()).decode()[:24]


class HttpError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(body.get("error", str(status)))
        self.status, self.body = status, body


def fail(status: int, error: str, **extra):
    raise HttpError(status, {"error": error, **extra})


def size(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


class Game:
    """One game: the part of a code's Durable Object that /api/game reads and writes."""

    def __init__(self):
        self.state, self.v, self.epoch, self.accept = {}, 0, secrets.token_hex(4), None
        self.players: dict[str, dict] = {}       # pid -> {pid, name, at, kicked}
        self.moves: list[dict] = []              # {seq, pid, k, slot?, data, at}, ordered by seq
        self.private: dict[str, object] = {}
        self.seq = 0

    def reset(self):
        self.players, self.moves, self.private = {}, [], {}
        self.state, self.accept, self.epoch = {}, None, secrets.token_hex(4)
        self.v += 1

    def count(self) -> int:
        return sum(1 for p in self.players.values() if not p["kicked"])

    def owner(self, m: dict) -> str:
        return m.get("slot") or m["pid"]

    def takes(self, k: str, t: int) -> bool:
        a = self.accept
        if a is None:
            return True
        if a.get("until") is not None and t > a["until"]:
            return False
        keys = a.get("moves")
        if keys is None:
            return True
        return any(k.startswith(p[:-1]) if p.endswith("*") else k == p for p in keys)


class MockService:
    """Everything the poll service stores, and a Playwright route handler over it."""

    def __init__(self, key: str = "rehearsal-only", origin: str = "http://t", ai=None, sdk: str | os.PathLike | None = None):
        self.key, self.origin = key, origin.rstrip("/")
        self.polls: dict[str, dict] = {}         # code -> {question, html, htmlAt, closed, createdAt}
        self.answers: dict[str, list] = {}       # code -> [{id, text, at, name?}]
        self.sessions: dict[str, dict] = {}      # s -> {active, at}
        self.games: dict[str, Game] = {}
        self.pages: dict[str, str] = {}          # path -> html this origin serves
        self.ai = ai or {}                       # task -> str | {"text", "json"} | fn(task, body) -> either
        self.ai_calls: list[dict] = []
        self.requests: list[tuple[str, str]] = []  # (method, path?query): what the pages asked
        self.sdk = pathlib.Path(sdk or config.get("TESSERA_GAME_SDK") or SDK)
        self.n = 0

    # ── the store ──────────────────────────────────────────────────────────
    def game(self, code: str) -> Game:
        return self.games.setdefault(code, Game())

    def publish(self, code: str, html: str):
        """What the deck does on the slide's first entry: the activity page, for the phones."""
        self.polls.setdefault(code, {})["html"] = html
        self.polls[code]["htmlAt"] = now_ms()

    def add_answer(self, code: str, text: str, name: str = "") -> dict:
        self.n += 1
        a = {"id": f"a{self.n:05d}", "text": text, "at": iso()}
        if name:
            a["name"] = name
        self.answers.setdefault(code, []).append(a)
        return a

    # ── routing ────────────────────────────────────────────────────────────
    def dispatch(self, method: str, url: str, headers: dict | None = None, body=None):
        """One request -> (status, json body | (content-type, text)). The route handler's core;
        the self-test calls it directly. `body` is a dict, a JSON string or None."""
        u = urllib.parse.urlparse(url)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        h = {k.lower(): v for k, v in (headers or {}).items()}
        if isinstance(body, (str, bytes)) and body:
            try:
                body = json.loads(body)
            except ValueError:
                body = {}
        body = body if isinstance(body, dict) else {}
        self.requests.append((method, u.path + ("?" + u.query if u.query else "")))
        if method == "OPTIONS":
            return 204, None
        try:
            if u.path in self.pages:
                return 200, ("text/html; charset=utf-8", self.pages[u.path])
            if u.path == "/game.js":
                return 200, ("text/javascript", self.sdk_source())
            m = re.fullmatch(r"/lib/([a-z0-9-]+)\.js", u.path)
            if m and (LIBS / f"{m.group(1)}.js").exists():
                return 200, ("text/javascript", (LIBS / f"{m.group(1)}.js").read_text(encoding="utf-8"))
            route = {"/api/answer": self.r_answer, "/api/poll": self.r_poll, "/api/session": self.r_session,
                     "/api/game": self.r_game, "/api/ai": self.r_ai, "/api/qr": self.r_qr,
                     "/api/lecturer": self.r_lecturer, "/api/upload": self.r_upload}.get(u.path)
            if not route:
                return 404, {"error": "not mocked: " + u.path}
            return route(method, q, h, body)
        except HttpError as e:
            return e.status, e.body

    def lecturer(self, h) -> bool:
        return bool(self.key) and header(h, LECTURER_HEADERS) == self.key

    def need_key(self, h):
        if not self.lecturer(h):
            fail(401, "lecturer key required")

    @staticmethod
    def code_of(q, b) -> str:
        code = str(q.get("c") or b.get("code") or "").strip().lower()
        if not CODE_RE.match(code):
            fail(400, "bad code")
        return code

    # /api/answer
    def r_answer(self, method, q, h, b):
        if method != "POST":
            fail(405, "method not allowed")
        code = self.code_of({}, b)
        text = str(b.get("text") or "").strip()
        if not text:
            fail(400, "empty answer")
        if len(text) > MAX_ANSWER_CHARS:
            fail(413, f"answer too long (max {MAX_ANSWER_CHARS} characters)")
        poll = self.polls.get(code)
        if poll and poll.get("closed"):
            fail(403, "This question is closed.", closed=True)
        if len(self.answers.get(code, [])) >= MAX_ANSWERS:
            fail(429, "this poll is full")
        name = re.sub(r"\s+", " ", str(b.get("name") or "").strip())[:MAX_NAME_CHARS]
        self.add_answer(code, text, name)
        poll = self.polls.setdefault(code, {"createdAt": iso()})
        if not poll.get("question") and b.get("question"):
            poll["question"] = str(b["question"])[:2000]
        return 200, {"ok": True, "count": len(self.answers[code])}

    # /api/poll
    def r_poll(self, method, q, h, b):
        if method == "POST":
            self.need_key(h)
            code = self.code_of({}, b)
            html = str(b.get("html") or "")
            if not html.strip():
                fail(400, "empty html")
            if len(html) > MAX_ACTIVITY_HTML_CHARS:
                fail(413, f"activity page too large (max {MAX_ACTIVITY_HTML_CHARS} characters)")
            self.publish(code, html)
            return 200, {"ok": True}
        code = self.code_of(q, {})
        if method == "DELETE":
            self.need_key(h)
            cleared = len(self.answers.pop(code, []))
            if code in self.games:            # Clear responses also resets the game
                self.games[code].reset()
            return 200, {"cleared": cleared, "images": 0}
        if method not in ("GET", "HEAD"):
            fail(405, "method not allowed")
        poll, ans = self.polls.get(code, {}), self.answers.get(code, [])
        out = {"code": code, "question": poll.get("question", ""), "count": len(ans),
               "answers": [dict(a) for a in ans] if self.lecturer(h) else [],
               "summary": "", "summaryAt": "", "html": poll.get("html", "")}
        if not self.lecturer(h):
            out["answersWithheld"] = True
        return 200, out

    # /api/session
    def r_session(self, method, q, h, b):
        if method in ("GET", "HEAD"):
            s = str(q.get("s") or "").strip().lower()
            if not (SESSION_RE.match(s) or CODE_RE.match(s)):
                fail(400, "bad code")
            st = self.sessions.get(s)
            return 200, {"session": s, "exists": bool(st), "active": (st or {}).get("active"),
                         "at": (st or {}).get("at", "")}
        if method != "POST":
            fail(405, "method not allowed")
        self.need_key(h)
        s = str(b.get("s") or "").strip().lower()
        if not (SESSION_RE.match(s) or CODE_RE.match(s)):
            fail(400, "bad code")
        if b.get("claim"):
            if s in self.sessions:
                return 200, {"ok": True, "existed": True}
            self.sessions[s] = {"active": None, "at": iso()}
            return 200, {"ok": True, "existed": False}
        active = b.get("active")
        if isinstance(active, dict) and CODE_RE.match(str(active.get("code", "")).lower()):
            active = {"code": str(active["code"]).lower(),
                      "kind": active.get("kind") if active.get("kind") in ("open", "choice", "rating", "quiz", "activity") else "open",
                      "question": str(active.get("question") or "")[:2000], "requireName": bool(active.get("requireName")),
                      **{k: active[k] for k in ("options", "questions", "min", "max", "minLabel", "maxLabel") if k in active}}
        else:
            active = None
        self.sessions[s] = {"active": active, "at": iso()}
        return 200, {"ok": True, "active": active}

    def r_qr(self, method, q, h, b):
        fg = re.sub(r"[^0-9A-Fa-f]", "", q.get("fg", "131D41"))[:6] or "131D41"
        return 200, ("image/svg+xml", QR_SVG.format(fg=fg))

    def r_lecturer(self, method, q, h, b):
        return 200, {"required": True, "ok": self.lecturer(h)}

    def r_upload(self, method, q, h, b):
        if method != "POST":
            fail(405, "method not allowed")
        code = self.code_of(q, b)
        self.n += 1
        return 200, {"url": f"{self.origin}/api/blob?c={code}&id=b{self.n}", "id": f"b{self.n}", "bytes": 0,
                     "mime": "image/jpeg"}

    # /api/game  (docs/game.md)
    def r_game(self, method, q, h, b):
        code = self.code_of(q, b)
        g = self.game(code)
        token = header(h, PLAYER_HEADERS)
        if token and not TOKEN_RE.match(token):
            fail(400, "bad player token")
        pid = pid_of(code, token) if token else ""
        t = now_ms()
        if method in ("GET", "HEAD"):
            out = {"code": code, "v": g.v, "epoch": g.epoch, "state": g.state, "accept": g.accept,
                   "now": t, "count": g.count()}
            if pid:
                p = g.players.get(pid)
                mine = {}
                for m in g.moves:
                    if m["pid"] == pid:
                        mine[m["k"]] = {"data": m["data"], "at": m["at"], "seq": m["seq"],
                                        **({"slot": m["slot"]} if m.get("slot") else {})}
                out["me"] = {"pid": pid, "name": p["name"] if p else "", "joined": bool(p),
                             "kicked": bool(p and p["kicked"]), "private": g.private.get(pid), "moves": mine}
            if self.lecturer(h):
                try:
                    since = max(0, int(float(q.get("since") or 0)))
                except ValueError:
                    since = 0
                out["players"] = [dict(p) for p in sorted(g.players.values(), key=lambda p: (p["at"], p["pid"]))]
                rows = [dict(m) for m in g.moves if m["seq"] > since]
                out["seq"] = g.seq
                if len(rows) > MAX_MOVES_PER_READ:      # paged: the rest with the next since
                    rows = rows[:MAX_MOVES_PER_READ]
                    out["seq"], out["more"] = rows[-1]["seq"], True
                out["moves"] = rows
            return 200, json.loads(json.dumps(out))
        if method != "POST":
            fail(405, "method not allowed")
        op = b.get("op")
        if op == "join":
            if not pid:
                fail(400, "x-tessera-player (the device token) is required")
            if g.accept is not None and g.accept.get("join") is False and pid not in g.players:
                fail(403, "Joining is closed.", closed=True)
            if pid not in g.players and len(g.players) >= MAX_PLAYERS:   # kicked ones count
                fail(429, "This game is full.")
            name = b.get("name")
            if name is not None:
                name = re.sub(r"\s+", " ", str(name).strip())[:MAX_NAME_CHARS]
            p = g.players.get(pid) or {"pid": pid, "name": "", "at": t}
            p.update(name=p["name"] if name is None else name, kicked=False)
            g.players[pid] = p
            return 200, {"pid": pid, "epoch": g.epoch, "name": p["name"]}
        if op == "move":
            if not pid:
                fail(400, "x-tessera-player (the device token) is required")
            k, slot, mode = str(b.get("k") or ""), b.get("slot"), b.get("mode") or "last"
            if not KEY_RE.match(k):
                fail(400, "bad move key k")
            slot = None if slot in (None, "") else str(slot)
            if slot is not None and not KEY_RE.match(slot):
                fail(400, "bad slot")
            if mode not in ("last", "first"):
                fail(400, "mode must be last or first")
            data = b.get("data")
            if size(data) > MAX_MOVE_CHARS:
                fail(413, f"move data too large (max {MAX_MOVE_CHARS} characters)")
            p = g.players.get(pid)
            if not p:
                fail(403, "Join the game first.", joined=False)
            if p["kicked"]:
                fail(403, "You were removed from this game.", kicked=True)
            if not g.takes(k, t):
                fail(403, "This round is closed.", closed=True)
            owner = slot or pid
            prev = next((m for m in g.moves if m["k"] == k and g.owner(m) == owner), None)
            if prev and mode == "first":
                fail(409, "taken", by=prev["pid"], at=prev["at"])
            if not prev and len(g.moves) >= MAX_MOVES:
                fail(429, "This game has taken all the moves it can.")
            if prev:
                g.moves.remove(prev)
            g.seq += 1
            m = {"seq": g.seq, "pid": pid, "k": k, "data": json.loads(json.dumps(data)), "at": t}
            if slot:
                m["slot"] = slot
            g.moves.append(m)
            return 200, {"ok": True, "seq": g.seq, "at": t}
        if op in ("state", "kick", "reset"):
            self.need_key(h)
        if op == "state":
            if b.get("ifV") is not None and (not isinstance(b["ifV"], int) or isinstance(b["ifV"], bool)):
                fail(400, "ifV must be an integer")
            if "state" in b and size(b["state"]) > MAX_STATE_CHARS:
                fail(413, f"state too large (max {MAX_STATE_CHARS} characters)")
            priv = b.get("private") or {}
            if not isinstance(priv, dict):
                fail(400, "private must be {pid: value}")
            for k, v in priv.items():
                if not PID_RE.match(k):
                    fail(400, f"bad pid in private: {json.dumps(k)}")
                if v is not None and size(v) > MAX_PRIVATE_CHARS:
                    fail(413, f"private value for {k} too large (max {MAX_PRIVATE_CHARS} characters)")
            if "accept" in b and b["accept"] is not None:
                a = b["accept"]
                if not isinstance(a, dict):
                    fail(400, "accept must be null or an object")
                if "join" in a and not isinstance(a["join"], bool):
                    fail(400, "accept.join must be true or false")
                if a.get("moves") is not None and (not isinstance(a["moves"], list) or any(
                        not isinstance(x, str) or not (x == "*" or KEY_RE.match(x[:-1] if x.endswith("*") else x))
                        for x in a["moves"])):
                    fail(400, "bad key pattern in accept.moves")
                if a.get("until") is not None and (not isinstance(a["until"], (int, float)) or isinstance(a["until"], bool)):
                    fail(400, "accept.until must be a time in ms")
            if b.get("ifV") is not None and b["ifV"] != g.v:
                fail(409, "stale", v=g.v, state=g.state)
            if "state" in b:
                g.state = json.loads(json.dumps(b["state"]))
            if "accept" in b:
                g.accept = json.loads(json.dumps(b["accept"]))
            for k, v in priv.items():
                if v is None:
                    g.private.pop(k, None)
                else:
                    g.private[k] = json.loads(json.dumps(v))
            g.v += 1
            return 200, {"v": g.v}
        if op == "kick":
            if not PID_RE.match(str(b.get("pid") or "")):
                fail(400, "bad pid")
            p = g.players.get(str(b.get("pid") or ""))
            if not p:
                fail(404, "no such player")
            p["kicked"] = True
            return 200, {"ok": True}
        if op == "reset":
            g.reset()
            return 200, {"v": g.v, "epoch": g.epoch}
        fail(400, "op must be join, move, state, kick or reset")

    # /api/ai  (server/poll-worker/src/api/ai.js; the model is canned)
    def r_ai(self, method, q, h, b):
        if method != "POST":
            fail(405, "method not allowed")
        code = self.code_of(q, b)
        lect = self.lecturer(h)
        task = "" if b.get("task") in (None, "") else str(b["task"])
        if task and not KEY_RE.match(task):
            fail(400, "bad task name")
        poll = self.polls.get(code, {})
        m = AI_TASKS.search(poll.get("html", ""))
        try:
            tasks = (json.loads(m.group(1)).get("tasks") or None) if m else None
        except ValueError:
            tasks = None
        spec = {}
        if not lect:
            if not task:
                fail(400, "task is required")
            if not tasks or not now_ms() - poll.get("htmlAt", 0) < AI_OPEN_HOURS * 3600_000:
                fail(403, "The AI opens when this activity is on screen.", closed=True)
            if not isinstance(tasks.get(task), dict):
                fail(400, f'this activity declares no AI task "{task}"')
            spec = tasks[task]
        elif task:
            spec = (tasks or {}).get(task) if isinstance((tasks or {}).get(task), dict) else None
            if spec is None and b.get("system") is None:
                fail(400, f'this activity declares no AI task "{task}"')
            spec = spec or {}
        if lect and b.get("system") is not None and len(str(b["system"])) > MAX_AI_SYSTEM:
            fail(413, f"system too long (max {MAX_AI_SYSTEM} characters)")
        inp = str(b.get("input") or "")
        if len(inp) > MAX_AI_INPUT:
            fail(413, f"input too long (max {MAX_AI_INPUT} characters)")
        if not inp.strip() and not b.get("image"):
            fail(400, "input is empty")
        want_json = bool(b["json"] if b.get("json") is not None else spec.get("json"))
        self.ai_calls.append({"code": code, "task": task, "input": inp, "image": bool(b.get("image")),
                              "json": want_json, "system": b.get("system") if lect else spec.get("system")})
        reply = self.ai.get(task) if task in self.ai else self.ai.get("*")
        if callable(reply):
            reply = reply(task, b)
        if reply is None:
            reply = {"text": f"[mock {task or 'lecturer'}] {inp[:80]}", "json": {} if want_json else None}
        if isinstance(reply, str):
            reply = {"text": reply}
        out = {"text": reply.get("text", "")}
        if want_json:
            js = reply.get("json")
            if js is None:
                try:
                    js = json.loads(out["text"])
                except ValueError:
                    js = None
            if js is not None:
                out["json"] = js
        return 200, out

    # ── Playwright ─────────────────────────────────────────────────────────
    def handle(self, route):
        """`ctx.route(svc.origin + "/**", svc.handle)`."""
        req = route.request
        status, out = self.dispatch(req.method, req.url, req.headers, req.post_data)
        if out is None:
            return route.fulfill(status=status, headers=CORS, body="")
        if isinstance(out, tuple):
            return route.fulfill(status=status, headers=CORS, content_type=out[0], body=out[1])
        return route.fulfill(status=status, headers=CORS, content_type="application/json", body=json.dumps(out))

    def attach(self, ctx):
        ctx.route(self.origin + "/**", self.handle)
        return self

    def sdk_source(self) -> str:
        if not self.sdk.exists():
            raise SystemExit(f"mock_service: the game SDK is not there yet: {self.sdk}\n"
                             "A page with <meta name=\"tessera-game\"> needs it (slides/src/game-sdk.js, "
                             "or point $TESSERA_GAME_SDK / MockService(sdk=...) at a copy).")
        return self.sdk.read_text(encoding="utf-8")

    def with_sdk(self, html: str) -> str:
        """The SDK script, when the page opts in with <meta name="tessera-game">."""
        if not GAME_META.search(html):
            return ""
        return "<script>" + self.sdk_source().replace("</script", "<\\/script") + "</script>"


def js_literal(obj) -> str:
    return json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c")


EMBED, ACTIVITY = "TESSERA_EMBED", "TESSERA_ACTIVITY"
TEXT_FN = ("(function(){var E=window." + EMBED + ";var T=E.texts||(E.texts={});"
           "E.text=function(k,d){return Object.prototype.hasOwnProperty.call(T,k)?T[k]:d;};})();")


def both(new: str, old: str, value: str) -> str:
    """JS that sets a host global under its new name and its old one (one object)."""
    return f"window.{new}=window.{old}={value}"



def screen_html(svc: MockService, html: str, code: str, *, key: str | None = None, texts: dict | None = None,
                session: str = "srehrs", question: str = "Rehearsal", kind: str = "activity") -> str:
    """The page as a deck embed gets it: TESSERA_EMBED (render.ts embedPreamble), then the SDK, then the page."""
    emb = {"texts": texts or {}, "editable": False,
           "poll": {"service": svc.origin, "session": session, "lecturer": svc.key if key is None else key,
                    "previous": {"code": code, "kind": kind, "question": question, "join": session}}}
    return ("<script>" + both(EMBED, legacy.EMBED_GLOBAL, js_literal(emb)) + "</script><script>" + TEXT_FN + "</script>"
            + svc.with_sdk(html) + html)


def phone_html(svc: MockService, html: str, code: str, name: str = "", token: str | None = None) -> str:
    """The page as the join page's activity frame gets it: TESSERA_ACTIVITY, then the SDK, then the page."""
    host = {"code": code, "name": name, "player": token or device_token(),
            "limits": {"answer": MAX_ANSWER_CHARS, "upload": 600 * 1024}}
    return "<script>" + both(ACTIVITY, legacy.ACTIVITY_GLOBAL, js_literal(host)) + ";</script>" + svc.with_sdk(html) + html


def open_screen(ctx, svc: MockService, html: str, code: str, *, path: str = "/screen.html", size=(1280, 720),
                errors: list | None = None, **kw):
    """A screen page (the deck embed) at svc.origin + path. kw: key ('' = no lecturer key), texts, session."""
    svc.pages[path] = screen_html(svc, html, code, **kw)
    page = ctx.new_page()
    page.set_viewport_size({"width": size[0], "height": size[1]})
    if errors is not None:
        page.on("pageerror", lambda e: errors.append(f"screen: {e}"))
    page.goto(svc.origin + path)
    return page


def with_texts(html: str, texts: dict | None) -> str:
    """What the deck publishes for an activity whose slide's embeds carry `texts`
    (poll.ts activityPageWithTexts): TESSERA_EMBED.texts and text() in front of the page
    (the same object under the old name too)."""
    if not texts:
        return html
    old = legacy.EMBED_GLOBAL
    init = ("<script>(function(){var E=window." + EMBED + "=window." + old + "=Object.assign(window." + EMBED
            + "||window." + old + "||{},{texts:"
            + js_literal(texts) + "});if(typeof E.text!=='function')E.text=function(k,d){return "
            "Object.prototype.hasOwnProperty.call(E.texts,k)?E.texts[k]:d};})()</script>")
    out = init + html
    return out if len(out) <= MAX_ACTIVITY_HTML_CHARS else html


def open_phones(ctx, svc: MockService, html: str, names, code: str, *, prefix: str = "/phone", size=(390, 844),
                errors: list | None = None, publish: bool = True, texts: dict | None = None):
    """One activity page per name (an int n opens n unnamed phones). Each phone has its own device token,
    derived from its name, so a reload is the same player. Returns the pages, in order; each page's
    token is in page.tessera_token and its pid in page.tessera_pid. `texts`: the screen embed's
    reworded labels, put in front of the page as the deck does when it publishes it."""
    if isinstance(names, int):
        names = [""] * names
    html = with_texts(html, texts)
    if publish:
        svc.publish(code, html)
    pages = []
    for i, name in enumerate(names):
        token = device_token(f"{code}:{i}:{name}")
        path = f"{prefix}{i}.html"
        svc.pages[path] = phone_html(svc, html, code, name, token)
        page = ctx.new_page()
        page.set_viewport_size({"width": size[0], "height": size[1]})
        if errors is not None:
            page.on("pageerror", lambda e, n=name or i: errors.append(f"phone {n}: {e}"))
        page.goto(svc.origin + path)
        page.tessera_token, page.tessera_pid = token, pid_of(code, token)
        pages.append(page)
    return pages


# ── self-test ────────────────────────────────────────────────────────────────

def self_test(browser: bool = False) -> int:
    fails = []

    def check(ok, what):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            fails.append(what)

    svc = MockService(ai={"judge": {"text": '{"score": 7}', "json": {"score": 7}}})
    K = {"x-tessera-lecturer": svc.key}
    C = "k7m3pq"
    G = f"{svc.origin}/api/game?c={C}"

    def call(method, url, headers=None, body=None):
        return svc.dispatch(method, url, headers, body)

    def P(tok):
        return {"x-tessera-player": tok}

    # answers and polls
    s, o = call("POST", f"{svc.origin}/api/answer", body={"code": C, "text": "hello", "name": " Ana  G ", "question": "Q?"})
    check(s == 200 and o["count"] == 1, "answer accepted")
    s, o = call("GET", f"{svc.origin}/api/poll?c={C}")
    check(s == 200 and o["answers"] == [] and o.get("answersWithheld") and o["count"] == 1 and o["question"] == "Q?",
          "GET /api/poll without the key withholds answers, keeps count and question")
    s, o = call("GET", f"{svc.origin}/api/poll?c={C}", K)
    check(o["answers"][0]["name"] == "Ana G" and "answersWithheld" not in o, "with the key: answers, name normalised")
    check(call("POST", f"{svc.origin}/api/poll", {"x-tessera-lecturer": "wrong"}, {"code": C, "html": "<p>x"})[0] == 401,
          "publish needs the key")
    check(call("POST", f"{svc.origin}/api/poll", K, {"code": C, "html": "x" * 60001})[0] == 413, "publish over 60 000 refused")
    check(call("GET", f"{svc.origin}/api/poll?c=BAD!")[0] == 400, "bad code refused")
    check(call("POST", f"{svc.origin}/api/session", K, {"s": "srehrs", "active": {"code": C, "kind": "activity", "requireName": 1}})[0] == 200
          and call("GET", f"{svc.origin}/api/session?s=srehrs")[1]["active"]["requireName"] is True, "session set and read")
    check(call("POST", f"{svc.origin}/api/session", {}, {"s": "srehrs", "active": None})[0] == 401, "session write needs the key")
    s, o = call("GET", f"{svc.origin}/api/poll?c={C}", {legacy.LECTURER_HEADER: svc.key})
    check(s == 200 and "answersWithheld" not in o, "the old lecturer header is still read")

    # game: players
    a, b2, c = device_token("a"), device_token("b"), device_token("c")
    s, o = call("GET", G, P(a))
    check(s == 200 and o["me"]["joined"] is False and o["count"] == 0 and o["v"] == 0 and o["state"] == {},
          "a phone reads the game before joining")
    s, o = call("POST", G, P(a), {"op": "join", "name": "Ana"})
    check(s == 200 and o["pid"] == pid_of(C, a) and len(o["pid"]) == 12 and o["name"] == "Ana", "join -> pid from the token")
    check(pid_of(C, a) != pid_of("other1", a), "the pid differs across games")
    call("POST", G, P(b2), {"op": "join", "name": "Marc"})
    check(call("GET", G, {legacy.PLAYER_HEADER: a})[1]["me"]["joined"] is True, "the old player header is still read")
    s, o = call("GET", G, P(a))
    check("players" not in o and "moves" not in o and o["count"] == 2, "a phone never sees the roster or others' moves")
    check(call("POST", G, {}, {"op": "join", "name": "x"})[0] == 400, "join without a token refused")
    check(call("POST", G, P(c), {"op": "move", "k": "r1", "data": 1})[0] == 403, "a move before joining is refused")

    # moves, modes, slots
    s1 = call("POST", G, P(a), {"op": "move", "k": "r1", "data": {"pick": 1}})
    s2 = call("POST", G, P(a), {"op": "move", "k": "r1", "data": {"pick": 2}})
    check(s1[0] == s2[0] == 200 and s2[1]["seq"] > s1[1]["seq"], "mode last replaces with a new seq")
    s, o = call("GET", G, K)
    check([m["data"] for m in o["moves"] if m["k"] == "r1"] == [{"pick": 2}] and o["seq"] == s2[1]["seq"],
          "the screen sees only the latest move under (owner, k)")
    f1 = call("POST", G, P(a), {"op": "move", "k": "buzz", "data": 1, "mode": "first", "slot": "room"})
    f2 = call("POST", G, P(b2), {"op": "move", "k": "buzz", "data": 1, "mode": "first", "slot": "room"})
    check(f1[0] == 200 and f2[0] == 409 and f2[1]["error"] == "taken" and f2[1]["by"] == pid_of(C, a),
          "mode first on a shared slot: the second is 409 taken, by the first pid")
    check(call("POST", G, P(b2), {"op": "move", "k": "buzz", "data": 1, "mode": "first"})[0] == 200,
          "without the slot the owner is the pid, so Marc's own first move is free")
    check(call("POST", G, P(a), {"op": "move", "k": "bad key!", "data": 1})[0] == 400, "bad k refused")
    check(call("POST", G, P(a), {"op": "move", "k": "big", "data": "x" * 4001})[0] == 413, "move over 4 000 chars refused")
    s, o = call("GET", G, P(a))
    check(set(o["me"]["moves"]) == {"r1", "buzz"} and o["me"]["moves"]["buzz"]["slot"] == "room",
          "me.moves: the moves this pid made, slot included")
    seq_now = call("GET", G, K)[1]["seq"]
    call("POST", G, P(b2), {"op": "move", "k": "r1", "data": {"pick": 0}})
    s, o = call("GET", G + f"&since={seq_now}", K)
    check(len(o["moves"]) == 1 and o["moves"][0]["pid"] == pid_of(C, b2), "since returns only newer moves")

    # accept
    check(call("POST", G, P(a), {"op": "state", "accept": {"moves": ["r2"]}})[0] == 401, "state needs the key")
    call("POST", G, K, {"op": "state", "accept": {"moves": ["q*"], "join": False}})
    check(call("POST", G, P(a), {"op": "move", "k": "r1", "data": 3})[1].get("closed") is True, "a key outside accept.moves: 403 closed")
    check(call("POST", G, P(a), {"op": "move", "k": "q7", "data": 3})[0] == 200, "a prefix pattern q* takes q7")
    check(call("POST", G, P(c), {"op": "join", "name": "Late"})[0] == 403, "join: false refuses a new pid")
    check(call("POST", G, P(a), {"op": "join", "name": "Ana"})[0] == 200, "join: false still lets a joined pid rejoin")
    call("POST", G, K, {"op": "state", "accept": {"moves": [], "until": now_ms() + 60_000}})
    check(call("POST", G, P(a), {"op": "move", "k": "q7", "data": 3})[0] == 403, "moves: [] closes the round")
    call("POST", G, K, {"op": "state", "accept": {"until": now_ms() - 1}})
    check(call("POST", G, P(a), {"op": "move", "k": "q8", "data": 3})[0] == 403, "until in the past closes it")
    call("POST", G, K, {"op": "state", "accept": None})
    check(call("GET", G)[1]["accept"] is None and call("POST", G, P(c), {"op": "join", "name": "Late"})[0] == 200,
          "accept: null takes everything again")

    # state, CAS, private
    s, o = call("GET", G)
    v = o["v"]
    s, o = call("POST", G, K, {"op": "state", "state": {"phase": "q", "r": 1}, "ifV": v,
                                "private": {pid_of(C, a): {"score": 3}}})
    check(s == 200 and o["v"] == v + 1, "state with ifV = v: written, v + 1")
    s, o = call("POST", G, K, {"op": "state", "state": {"phase": "other"}, "ifV": v})
    check(s == 409 and o["error"] == "stale" and o["v"] == v + 1 and o["state"]["phase"] == "q", "stale ifV: 409 with v and state")
    check(call("GET", G, P(a))[1]["me"]["private"] == {"score": 3} and call("GET", G, P(b2))[1]["me"]["private"] is None,
          "private reaches only its player")
    call("POST", G, K, {"op": "state", "private": {pid_of(C, a): None}})
    check(call("GET", G, P(a))[1]["me"]["private"] is None and call("GET", G)[1]["state"]["phase"] == "q",
          "private null removes it; state untouched when absent")
    check(call("POST", G, K, {"op": "state", "state": {"x": "y" * 100_001}})[0] == 413, "state over 100 000 refused")

    # kick, reset, Clear responses
    call("POST", G, K, {"op": "kick", "pid": pid_of(C, b2)})
    s, o = call("GET", G, P(b2))
    check(o["me"]["kicked"] is True and call("GET", G)[1]["count"] == 2, "kick flags the player; count drops")
    check(call("POST", G, P(b2), {"op": "move", "k": "r9", "data": 1})[0] == 403, "a kicked player cannot move")
    check(call("POST", G, P(b2), {"op": "join", "name": "Marc"})[0] == 200 and not call("GET", G, P(b2))[1]["me"]["kicked"],
          "join again clears kicked")
    ep = call("GET", G)[1]["epoch"]
    s, o = call("POST", G, K, {"op": "reset"})
    st = call("GET", G, K)[1]
    check(s == 200 and o["epoch"] != ep and st["players"] == [] and st["moves"] == [] and st["state"] == {}
          and st["accept"] is None, "reset: players, moves, private gone, new epoch")
    call("POST", G, P(a), {"op": "join", "name": "Ana"})
    ep = call("GET", G)[1]["epoch"]
    call("DELETE", f"{svc.origin}/api/poll?c={C}", K)
    check(call("GET", G)[1]["epoch"] != ep and call("GET", G)[1]["count"] == 0, "DELETE /api/poll resets the game too")

    # ai
    page = '<meta name="tessera-game"><script type="application/json" id="tessera-ai">{"tasks":{"judge":{"system":"s","json":true}}}</script>'
    call("POST", f"{svc.origin}/api/poll", K, {"code": C, "html": page})
    s, o = call("POST", f"{svc.origin}/api/ai", {}, {"code": C, "task": "judge", "input": "idea"})
    check(s == 200 and o["json"] == {"score": 7}, "ai: a declared task gets the canned reply")
    check(call("POST", f"{svc.origin}/api/ai", {}, {"code": C, "task": "other", "input": "x"})[0] == 400,
          "ai: an undeclared task is refused")
    check(call("POST", f"{svc.origin}/api/ai", K, {"code": C, "system": "be brief", "input": "x"})[0] == 200,
          "ai: the lecturer may send system instead of a task")
    check(call("POST", f"{svc.origin}/api/ai", {}, {"code": C, "task": "judge", "input": "x" * 4001})[0] == 413,
          "ai: input over 4 000 refused")
    svc.polls[C]["htmlAt"] = now_ms() - 4 * 3600_000
    check(call("POST", f"{svc.origin}/api/ai", {}, {"code": C, "task": "judge", "input": "x"})[0] == 403,
          "ai: closed 3 h after the last publish")
    check(call("GET", f"{svc.origin}/lib/confetti.js")[0] == 200 or not LIBS.exists(), "serves /lib/NAME.js")
    check(call("OPTIONS", G)[0] == 204, "preflight answered")

    if browser:
        from playwright.sync_api import sync_playwright
        from shoot import find_chrome
        svc2 = MockService()
        page_src = "<!doctype html><title>t</title><p id=o>…</p>"
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=find_chrome())
            ctx = br.new_context()
            svc2.attach(ctx)
            scr = open_screen(ctx, svc2, page_src, C)
            ph = open_phones(ctx, svc2, page_src, ["Ana", "Marc"], C)
            r = ph[0].evaluate("""async () => {
                const A = window.TESSERA_ACTIVITY, H = {'content-type': 'application/json', 'x-tessera-player': A.player};
                const j = await (await fetch('/api/game', {method: 'POST', headers: H, body: JSON.stringify({code: A.code, op: 'join', name: A.name})})).json();
                const m = await fetch('/api/game', {method: 'POST', headers: H, body: JSON.stringify({code: A.code, op: 'move', k: 'b1', data: 1, mode: 'first', slot: 'room'})});
                return {pid: j.pid, status: m.status};
            }""")
            check(r["pid"] == ph[0].tessera_pid and r["status"] == 200, "browser: a phone joins and moves through the route")
            r = ph[1].evaluate("""async () => {
                const A = window.TESSERA_ACTIVITY, H = {'content-type': 'application/json', 'x-tessera-player': A.player};
                await fetch('/api/game', {method: 'POST', headers: H, body: JSON.stringify({code: A.code, op: 'join', name: A.name})});
                const m = await fetch('/api/game', {method: 'POST', headers: H, body: JSON.stringify({code: A.code, op: 'move', k: 'b1', data: 1, mode: 'first', slot: 'room'})});
                return {status: m.status, body: await m.json()};
            }""")
            check(r["status"] == 409 and r["body"]["by"] == ph[0].tessera_pid, "browser: the second buzz is 409 taken")
            r = scr.evaluate("""async () => {
                const P = window.TESSERA_EMBED.poll;
                const d = await (await fetch(P.service + '/api/game?c=' + P.previous.code, {headers: {'x-tessera-lecturer': P.lecturer}})).json();
                return {players: d.players.length, moves: d.moves.length, text: window.TESSERA_EMBED.text('x', 'dflt')};
            }""")
            check(r == {"players": 2, "moves": 1, "text": "dflt"}, f"browser: the screen reads the roster with its key {r}")
            check(ph[0].evaluate(f"window.{legacy.ACTIVITY_GLOBAL} === window.TESSERA_ACTIVITY")
                  and scr.evaluate(f"window.{legacy.EMBED_GLOBAL} === window.TESSERA_EMBED"),
                  "browser: a page written before the rename finds the host objects under their old names")
            ph[0].reload()
            check(ph[0].evaluate("window.TESSERA_ACTIVITY.player") == ph[0].tessera_token, "browser: a reloaded phone keeps its token")
            br.close()
    print("\n" + ("ALL OK" if not fails else f"{len(fails)} FAILED"))
    return 1 if fails else 0


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--browser", action="store_true", help="with --self-test: also through Playwright")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test(a.browser))
    ap.print_help()
