"""python test/summarize_live.py — Summarize on the DEPLOYED service, with five made-up answers.

Posts five answers to a fresh scratch poll on your poll service, asks
/api/summarize (a real OpenRouter call), prints the summary, then clears the
scratch poll. The service is TESSERA_POLL_SERVICE and the lecturer key
TESSERA_LECTURER_KEY (or LECTURER_KEY), from the environment or from the first
.env found walking up from the current folder, then from this file's folder
(`npm run setup` writes both). The key is never printed.
"""
import json, os, random, sys, urllib.error, urllib.request
from pathlib import Path

URL_NAMES = ("TESSERA_POLL_SERVICE",)
KEY_NAMES = ("TESSERA_LECTURER_KEY", "LECTURER_KEY")


def find_env():
    for start in (Path.cwd(), Path(__file__).resolve().parent):
        for d in (start, *start.parents):
            if (d / ".env").is_file():
                return d / ".env"
    return None


def read_env(f):
    out = {}
    if f:
        for line in f.read_text(encoding="utf-8").splitlines():
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                out[k.strip().removeprefix("export ").strip()] = v.strip().strip('"').strip("'")
    return out


ENV_FILE = find_env()
FILE_VALUES = read_env(ENV_FILE)


def setting(names):
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    for n in names:
        if FILE_VALUES.get(n):
            return FILE_VALUES[n]
    return ""


BASE = setting(URL_NAMES).rstrip("/")
if not BASE:
    sys.exit("No TESSERA_POLL_SERVICE in the environment or a .env: run `npm run setup` (server/poll-worker) first.")
KEY = setting(KEY_NAMES)
if not KEY:
    sys.exit(f"No TESSERA_LECTURER_KEY in the environment or {ENV_FILE or 'a .env'}: run `npm run setup -- --existing --url {BASE}`.")


def call(method, path, body=None, key=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 # Cloudflare refuses Python's default user agent (error 1010).
                                 headers={"content-type": "application/json", "user-agent": "tessera-tools/1.0",
                                          **({"x-tessera-lecturer": key} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


QUESTION = "What is the biggest obstacle to using AI in your daily work?"
ANSWERS = [
    "I don't trust the answers enough to use them without checking everything, so it rarely saves time.",
    "Our company blocks most AI tools for data privacy reasons.",
    "Honestly I don't know which tool to use for what, there are too many.",
    "Checking the output takes as long as doing the task myself.",
    "Nobody in my team uses it, so there is no shared way of working with it.",
]

status, ok = call("GET", "/api/lecturer", key=KEY)
if not ok.get("ok"):
    sys.exit(f"The lecturer key is not the one set on {BASE} (GET /api/lecturer says ok:false).")

code = "zsum" + "".join(random.choice("abcdefghjkmnpqrtuvwxy346789") for _ in range(4))
print(f"{BASE}, scratch poll {code}: posting {len(ANSWERS)} answers")
for a in ANSWERS:
    s, d = call("POST", "/api/answer", {"code": code, "text": a, "question": QUESTION})
    assert s == 200, (s, d)
try:
    s, d = call("POST", "/api/summarize", {"code": code, "question": QUESTION}, key=KEY)
    print(f"summarize: HTTP {s}")
    if s == 200:
        print(f"{d['count']} responses summarized at {d['at']}:\n")
        print(d["summary"])
    else:
        print(d)
finally:
    s2, d2 = call("DELETE", f"/api/poll?c={code}", key=KEY)
    print(f"\ncleared scratch poll: HTTP {s2} {d2}")
sys.exit(0 if s == 200 else 1)
