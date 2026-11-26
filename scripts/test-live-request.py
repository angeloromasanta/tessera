"""The live deck server's two write routes, on a copy of the template: no user's deck touched.

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


    # ── /edit: what was changed in the page is written into the deck

    def doc(self):
        return json.loads(serve.DOC_RE.search(self.deck.read_text(encoding="utf-8")).group(2))

    def edit(self, patches, assets=None):
        body = json.dumps({"patches": patches, "assets": assets or {}}).encode()
        status, _, out, _ = serve.edit("x", body)
        return json.loads(out)

    def test_a_slide_deleted_in_the_page_is_deleted(self):
        before = self.ids()
        gone = self.doc()["slides"][2]
        rest = [i for i in before if i != gone["id"]]
        out = self.edit([{"path": ["slides", {"id": gone["id"]}], "before": {"stale": "copy"}},
                         {"path": ["slides"], "order": True, "before": before, "value": rest}])
        self.assertEqual(out["refused"], [])
        self.assertEqual(self.ids(), rest)
        # sent twice (the answer was lost on the way): nothing more happens
        self.edit([{"path": ["slides", {"id": gone["id"]}], "before": gone}])
        self.assertEqual(self.ids(), rest)

    def test_a_slide_added_and_moved_in_the_page(self):
        before = self.ids()
        slide = {"id": "slide-made-here", "background": "#FFFFFF", "transition": "morph", "elements": [], "notes": "",
                 "comments": [{"id": "c1", "request": True, "text": "never travels here"}]}
        order = [before[0], "slide-made-here", *before[1:]]
        self.edit([{"path": ["slides", {"id": "slide-made-here"}], "value": slide},
                   {"path": ["slides"], "order": True, "before": [*before, "slide-made-here"], "value": order}])
        self.assertEqual(self.ids(), order)
        made = next(s for s in self.doc()["slides"] if s["id"] == "slide-made-here")
        self.assertNotIn("comments", made)
        # a slide the page has not seen yet keeps its place after its neighbour
        self.slide_py("new", str(self.deck), "--empty", "--id", "slide-unseen", "--after", before[1])
        swapped = [order[1], order[0], *order[2:]]
        self.edit([{"path": ["slides"], "order": True, "before": order, "value": swapped}])
        ids = self.ids()
        self.assertEqual(ids[:2], swapped[:2])
        self.assertEqual(ids.index("slide-unseen"), ids.index(before[1]) + 1)

    def test_one_slide_refused_does_not_hold_back_another(self):
        a, b = self.doc()["slides"][1], self.doc()["slides"][2]
        out = self.edit([
            {"path": ["slides", {"id": a["id"]}, "notes"], "before": a.get("notes", ""), "value": "said in the page"},
            {"path": ["slides", {"id": b["id"]}, "notes"], "before": "not what the deck holds", "value": "lost"},
        ])
        self.assertEqual(out["applied"], [a["id"]])
        self.assertEqual([r["slide"] for r in out["refused"]], [b["id"]])
        slides = {s["id"]: s for s in self.doc()["slides"]}
        self.assertEqual(slides[a["id"]]["notes"], "said in the page")
        self.assertEqual(slides[b["id"]].get("notes", ""), b.get("notes", ""))

    def test_a_pasted_picture_comes_with_its_asset(self):
        a = self.doc()["slides"][1]
        el = {"id": "img-here", "type": "image", "x": 0, "y": 0, "w": 10, "h": 10, "src": "asset:img-pasted"}
        self.edit([{"path": ["slides", {"id": a["id"]}, "elements", {"id": "img-here"}], "value": el}],
                  {"img-pasted": "data:image/png;base64,AAAA", "img-unused": "data:image/png;base64,BBBB"})
        assets = self.doc()["assets"]
        self.assertEqual(assets["img-pasted"], "data:image/png;base64,AAAA")
        self.assertNotIn("img-unused", assets)

    def test_what_the_page_may_not_change(self):
        a = self.doc()["slides"][1]["id"]
        for bad in ([{"path": ["theme", "accent"], "value": "#000"}],
                    [{"path": ["assets", "x"], "value": "y"}],
                    [{"path": ["slides"], "value": []}],
                    [{"path": ["slides", {"id": a}, "comments"], "value": []}],
                    [{"path": ["slides", {"id": a}, "id"], "before": a, "value": "other"}],
                    []):
            with self.assertRaises(serve.Refused) as ctx:
                self.edit(bad)
            self.assertEqual(ctx.exception.status, 400)
        status = serve.serve("POST", "/x/edit", "", b"{}")[0]
        self.assertEqual(status, 403)   # no X-Key: a form on another site


if __name__ == "__main__":
    unittest.main()
