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

    def test_a_slide_added_in_the_mirror_is_added_to_the_deck(self):
        before = self.ids()
        self.assertEqual(self.post("slide-only-here", "req-c", "copy slide 2", after=self.second), 200)
        after = self.ids()
        self.assertEqual(after, before[:2] + ["slide-only-here"] + before[2:])   # same place as in the mirror
        out = self.open_requests()
        self.assertIn("slide-only-here  req-c  open", out)
        self.assertNotIn("added in the mirror", out)
        # an empty slide, as the editor's own "add slide" makes it
        slide = json.loads(self.slide_py("get", str(self.deck), "slide-only-here"))
        self.assertEqual(slide["elements"], [])
        # a second request on it, or the same one sent again, adds nothing
        self.assertEqual(self.post("slide-only-here", "req-c2", "and a chart", after=self.second), 200)
        self.assertEqual(self.ids(), after)

    def test_where_the_added_slide_goes(self):
        n = len(self.ids())
        self.assertEqual(self.post("slide-lead", "req-d", "an opener", first=True), 200)
        self.assertEqual(self.ids()[0], "slide-lead")
        self.assertEqual(self.post("slide-tail", "req-e", "a closer"), 200)                       # an older page: no position
        self.assertEqual(self.post("slide-lost", "req-f", "x", after="gone-slide"), 200)          # its neighbour is gone
        self.assertEqual(self.post("slide-odd", "req-g", "x", after="not an id!"), 200)
        self.assertEqual(self.ids()[-3:], ["slide-tail", "slide-lost", "slide-odd"])
        self.assertEqual(len(self.ids()), n + 4)

    def test_a_bad_request_is_still_refused(self):
        for slide, rid, text in (("bad id!", "req-f", "x"), (self.first, "bad id!", "x"), (self.first, "req-h", " ")):
            with self.assertRaises(serve.Refused) as ctx:
                self.post(slide, rid, text)
            self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
