"""Protocol/security tests using isolated state; no user's deck or bridge touched."""
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("agent-bridge.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        b.STATE_DIR = Path(self.temp.name) / "state"
        b.STATE_FILE = b.STATE_DIR / "connection.json"
        self.bridge = b.Bridge()
        self.cli = self.bridge.config["cliToken"]
        self.file = Path(self.temp.name) / "deck.html"
        self.file.write_text('<script type="application/tessera+json" id="tessera-doc">{}</script>', encoding="utf-8")
        self.pair = self.admin("/register", {"file": str(self.file)})

    def admin(self, route, body):
        return self.bridge.handle(route, body, self.cli, None)

    def tick(self, sid="one", reply=None):
        return self.bridge.handle("/tick", {"sessionId": sid, "docId": "doc", "file": self.pair["file"],
                                 "dirty": True, "reply": reply}, self.pair["token"], "null")

    def test_authentication_and_source_guard(self):
        # the guard is written on the first live edit or save, not on register
        self.assertFalse(b.marker(self.file).exists())
        b.stale(self.file)
        self.assertTrue(b.marker(self.file).exists())
        with self.assertRaises(PermissionError):
            self.bridge.handle("/sessions", {}, self.pair["token"], None)
        with self.assertRaises(PermissionError):
            self.bridge.handle("/sessions", {}, self.cli, "https://evil.example")
        with self.assertRaises(PermissionError):
            self.bridge.handle("/tick", {}, "invalid", "null")
        with self.assertRaises(PermissionError):
            self.bridge.handle("/tick", {}, self.pair["token"], "https://evil.example")
        self.tick()
        with self.assertRaises(ValueError):
            self.admin("/reconcile", {"file": str(self.file)})
        self.bridge.sessions["one"]["seen"] = 0
        self.admin("/reconcile", {"file": str(self.file)})
        self.assertFalse(b.marker(self.file).exists())
        self.tick()   # an open tab alone does not guard; a patch or a spec-deck save does
        self.assertFalse(b.marker(self.file).exists())

    def test_queue_acknowledgment_retries_and_identity(self):
        self.tick()
        request = {"id": "r1", "docId": "doc", "agent": "A", "patches": []}
        payload = {"sessionId": "one", "kind": "patch", "request": request}
        replies = []
        thread = threading.Thread(target=lambda: replies.append(self.admin("/request", payload)))
        thread.start()
        for _ in range(50):
            command = self.tick().get("command")
            if command:
                break
            time.sleep(.01)
        self.assertEqual(command["id"], "r1")
        self.assertEqual(self.tick()["command"], command)  # lost reply: redeliver same ID
        self.tick(reply={"commandId": "r1", "result": {"status": "applied", "id": "r1"}})
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(replies[0]["status"], "applied")
        self.assertEqual(self.admin("/request", payload), replies[0])
        payload["request"] = {**request, "agent": "changed"}
        with self.assertRaises(ValueError):
            self.admin("/request", payload)
        with self.assertRaises(ValueError):
            self.bridge.handle("/tick", {"sessionId": "one", "docId": "other", "file": self.pair["file"]}, self.pair["token"], "null")

    def test_copies_of_one_deck_route_to_one_tab(self):
        # Same docId: one deck in two tabs (they sync); a command goes to one.
        self.tick("one"); self.tick("two")
        first = self.bridge.session("one")["sessionId"]
        self.assertEqual(self.bridge.session("two")["sessionId"], first)  # sticky
        self.admin("/select", {"sessionId": "two"})
        self.assertEqual(self.bridge.session("two")["sessionId"], "two")
        with self.assertRaises(ValueError):
            self.bridge.session("one")

    def test_copies_with_different_documents_require_selection(self):
        self.tick("one")
        self.bridge.handle("/tick", {"sessionId": "two", "docId": "other", "file": self.pair["file"]},
                           self.pair["token"], "null")
        with self.assertRaises(ValueError):
            self.bridge.session("one")
        self.admin("/select", {"sessionId": "two"})
        self.assertEqual(self.bridge.session("two")["sessionId"], "two")

    def deck(self, doc, opener=b.DOC_OPEN):
        body = json.dumps(doc).replace("<", "\\u003c")
        return f'<!DOCTYPE html><html><head><title>x</title>{opener}\n{body}\n</script></head><body></body></html>'

    def save(self, doc, base=None, doc_id="doc"):
        return self.bridge.handle("/save", {"file": self.pair["file"], "docId": doc_id, "html": self.deck(doc), "base": base},
                                  self.pair["token"], "null")

    def test_save_refuses_a_changed_file_and_skips_identical_content(self):
        loaded = {"format": "tessera/slides", "docId": "doc", "slides": [{"id": "a", "notes": "0"}]}
        self.file.write_text(self.deck(loaded), encoding="utf-8")
        base = b.version_token(json.dumps(loaded))  # what the editor hashes from the block it loaded
        mine = {**loaded, "slides": [{"id": "a", "notes": "mine"}]}
        r = self.save(mine, base)
        self.assertTrue(r["written"])
        self.assertEqual(self.save(mine, r["token"])["written"], False)  # identical: no write
        # slide.py writes the file behind the tab's back
        theirs = {**loaded, "slides": [{"id": "a", "notes": "mine"}, {"id": "b", "notes": "agent"}]}
        self.file.write_text(self.deck(theirs), encoding="utf-8")
        with self.assertRaises(b.Conflict) as caught:
            self.save({**mine, "title": "later"}, r["token"])
        self.assertEqual(json.loads(caught.exception.body), theirs)
        self.assertIn('"agent"', self.file.read_text(encoding="utf-8"))
        # saving against the file's version now succeeds
        self.assertTrue(self.save({**theirs, "title": "later"}, caught.exception.token)["written"])

    def test_save_keeps_an_old_named_block(self):
        # a deck saved before the rename: its shell reads only the old block
        # name, so a save replaces the JSON and keeps the tag as it is
        old = {"format": "tessera/slides", "docId": "doc", "slides": [{"id": "a", "notes": "0"}]}
        self.file.write_text(self.deck(old, b.legacy.DOC_OPEN), encoding="utf-8")
        self.assertIsNotNone(b.find_block(self.file.read_text(encoding="utf-8")))
        base = b.version_token(json.dumps(old))
        mine = {**old, "slides": [{"id": "a", "notes": "mine"}]}
        self.assertTrue(self.save(mine, base)["written"])
        text = self.file.read_text(encoding="utf-8")
        self.assertIn(b.legacy.DOC_OPEN, text)
        self.assertNotIn(b.DOC_OPEN, text)
        self.assertIn('"mine"', text)

    def test_save_protects_a_file_without_docid(self):
        recompiled = {"format": "tessera/slides", "slides": [{"id": "a", "notes": "RECOMPILED"}]}
        self.file.write_text(self.deck(recompiled), encoding="utf-8")
        with self.assertRaises(b.Conflict):
            self.save({"format": "tessera/slides", "docId": "minted", "slides": [{"id": "a", "notes": "stale"}]},
                      "0" * 64, doc_id="minted")
        self.assertIn("RECOMPILED", self.file.read_text(encoding="utf-8"))

    def test_wait_reports_each_request_once_per_listener(self):
        self.bridge.handle("/tick", {"sessionId": "one", "docId": "doc", "file": self.pair["file"], "pending": 1,
                                     "pendingIds": ["r1"]}, self.pair["token"], "null")
        first = self.admin("/wait", {"file": self.pair["file"], "timeout": 1})
        self.assertEqual(first["new"], ["r1"])
        self.assertTrue(self.admin("/wait", {"file": self.pair["file"], "timeout": 1}).get("timeout"))
        self.assertEqual(self.admin("/wait", {"file": self.pair["file"], "timeout": 1, "listener": "other"})["new"], ["r1"])
        self.bridge.handle("/tick", {"sessionId": "one", "docId": "doc", "file": self.pair["file"], "pending": 2,
                                     "pendingIds": ["r1", "r2"]}, self.pair["token"], "null")
        self.assertEqual(self.admin("/wait", {"file": self.pair["file"], "timeout": 1})["new"], ["r2"])

    def test_wait_with_a_shell_that_reports_only_a_count(self):
        def tick(n):
            self.bridge.handle("/tick", {"sessionId": "one", "docId": "doc", "file": self.pair["file"], "pending": n},
                               self.pair["token"], "null")
        tick(1)
        self.assertTrue(self.admin("/wait", {"timeout": 1})["sessions"])
        self.assertTrue(self.admin("/wait", {"timeout": 1}).get("timeout"))
        tick(0); tick(1)  # served, then a new one
        self.assertTrue(self.admin("/wait", {"timeout": 1})["sessions"])

    def test_disconnected_sessions_and_unknown_results(self):
        self.tick()
        self.bridge.sessions["one"]["seen"] = 0
        with self.assertRaises(ValueError):
            self.bridge.session("one")
        self.assertEqual(self.admin("/result", {"sessionId": "one", "id": "missing"}), {"status": "unknown"})

    def test_long_running_bridge_forgets_old_sessions_and_commands(self):
        self.tick("one"); self.tick("two")
        self.admin("/select", {"sessionId": "two"})
        self.bridge.commands[("two", "old")] = {"wire": {}, "expires": time.time() - b.COMMAND_TTL - 1}
        self.bridge.commands[("two", "new")] = {"wire": {}, "expires": time.time()}
        self.bridge.sessions["two"]["seen"] = time.time() - b.SESSION_TTL - 1
        self.tick("one")
        self.assertNotIn("two", self.bridge.sessions)
        self.assertEqual(self.bridge.selected, {})
        self.assertEqual(list(self.bridge.commands), [("two", "new")])

    def test_read_snapshot_is_not_kept_after_delivery(self):
        self.tick()
        replies = []
        thread = threading.Thread(target=lambda: replies.append(
            self.admin("/request", {"sessionId": "one", "kind": "read"})))
        thread.start()
        for _ in range(50):
            command = self.tick().get("command")
            if command:
                break
            time.sleep(.01)
        self.tick(reply={"commandId": command["id"], "result": {"doc": {"big": "x"}}})
        thread.join(2)
        self.assertEqual(replies[0], {"doc": {"big": "x"}})
        self.assertEqual(self.bridge.commands, {})

    def test_authoring_tools_refuse_guarded_disk_writes(self):
        tools = Path(__file__).resolve().parents[1] / "tools"
        if not (tools / "md_to_deck.py").is_file():
            self.skipTest("no tools/ in this checkout")
        sys.path.insert(0, str(tools))
        import md_to_deck
        import deck_build
        b.stale(self.file)   # as after the first live edit
        before = self.file.read_bytes()
        with self.assertRaises(SystemExit):
            md_to_deck.compile_deck(Path("missing.md"), Path("missing.html"), self.file)
        with self.assertRaises(SystemExit):
            deck_build.write_deck(None, {}, self.file)
        self.assertEqual(self.file.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
