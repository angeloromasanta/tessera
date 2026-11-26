"""The live mirror's one write route, on a copy of the template: no user's deck touched.

    python scripts/test-live-request.py
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("live_serve", ROOT / "tools" / "live" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.deck = Path(self.temp.name) / "deck.html"
        shutil.copy(ROOT / "template.html", self.deck)
        real = serve._path
        serve._path = lambda slug: self.deck
        self.addCleanup(setattr, serve, "_path", real)
        self.first, self.second = self.ids()[:2]

    def slide_py(self, *args):
        r = subprocess.run([sys.executable, str(ROOT / "tools" / "slide.py"), *args],
                           capture_output=True, text=True, encoding="utf-8")
        return r.stdout + r.stderr

    def ids(self):
        return [line.split()[1] for line in self.slide_py("ls", str(self.deck)).splitlines()
                if line.split()[:1] and line.split()[0].isdigit()]

    def post(self, slide, rid, text, **more):
        body = json.dumps({"slideId": slide, "request": {"id": rid, "text": text}, **more}).encode()
        return serve.request("x", body)[0]

    def open_requests(self):
        return self.slide_py("requests", str(self.deck))

    def test_on_a_slide_of_the_deck(self):
        self.assertEqual(self.post(self.first, "req-a", "shorter title"), 200)
        out = self.open_requests()
        self.assertIn(f"{self.first}  req-a  open", out)
        self.assertNotIn("added in the mirror", out)

    def test_about_the_whole_deck(self):
        self.assertEqual(self.post("", "req-b", "one more example"), 200)
        self.assertIn("whole deck  req-b  open", self.open_requests())

    def test_on_a_slide_that_exists_only_in_the_mirror(self):
        self.assertEqual(self.post("slide-only-here", "req-c", "copy slide 2", after=self.second), 200)
        out = self.open_requests()
        self.assertIn("whole deck  req-c  open", out)
        self.assertIn(f"[typed on a slide added in the mirror after {self.second}, "
                      "not in the deck: slide-only-here] copy slide 2", out)
        self.assertEqual(self.ids().count("slide-only-here"), 0)   # the deck's slides are untouched

    def test_mirror_only_slide_without_or_with_a_bad_position(self):
        self.assertEqual(self.post("slide-only-here", "req-d", "hello"), 200)
        self.assertEqual(self.post("slide-only-here", "req-e", "hello", after="not an id!"), 200)
        out = self.open_requests()
        self.assertEqual(out.count("[typed on a slide added in the mirror, not in the deck: slide-only-here] hello"), 2)

    def test_a_bad_request_is_still_refused(self):
        for slide, rid, text in (("bad id!", "req-f", "x"), (self.first, "bad id!", "x"), (self.first, "req-g", " ")):
            with self.assertRaises(serve.Refused) as ctx:
                self.post(slide, rid, text)
            self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
