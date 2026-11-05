"""Isolated headless integration: real file:// shell, localhost HTTP, live redraw.

Requires this workspace's shoot.py dependencies. Does not open the user's browser.
It serves its own bridge on the bridge's fixed port (the shell only knows that
one), so stop the real bridge first: on Windows a second server would share
the port with it and take its traffic.
"""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


bridge = module("bridge", ROOT / "scripts/agent-bridge.py")
shoot = module("shoot", ROOT / "tools/shoot.py")
(ROOT / "testing").mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=ROOT / "testing") as tmp:
    folder = Path(tmp)
    bridge.STATE_DIR = folder / "state"
    bridge.STATE_FILE = bridge.STATE_DIR / "connection.json"
    server = bridge.ThreadingHTTPServer(("127.0.0.1", bridge.PORT), bridge.Handler)
    server.bridge = bridge.Bridge()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    doc = {"format": "tessera/slides", "version": 1, "docId": "agent-browser-test", "title": "Live agent test",
           "modified": "2026-01-01", "size": {"width": 1280, "height": 720},
           "theme": {"background": "#fff", "color": "#111", "accent": "#214A9F", "fontFamily": "Arial"},
           "assets": {}, "slides": [{"id": "first", "background": "#fff", "transition": "fade", "notes": "",
                                      "elements": [{"id": "title", "type": "text", "x": 60, "y": 100, "w": 1100, "h": 150,
                                                    "fontSize": 60, "html": "Before agent edit"}]}]}
    shell = (ROOT / "slides/dist-single/tessera.html").read_text(encoding="utf-8")
    deck = folder / "test.html"
    pattern = r'(<script type="application/tessera\+json" id="tessera-doc">)[\s\S]*?(</script>)'
    deck.write_text(re.sub(pattern, lambda m: m[1] + json.dumps(doc).replace('<', '\\u003c') + m[2], shell), encoding="utf-8")
    pair = bridge.call("/register", {"file": str(deck)})
    proc = cdp = None
    try:
        proc, ws = shoot.launch_chrome(["--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900"],
                                      "about:blank", str(folder / "profile"), lambda t: t.get("type") == "page")
        cdp = shoot.CDP(ws)
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        # Seed pairing as a previously paired local browser; no privileges bypassed.
        script = "localStorage.setItem(" + json.dumps("tessera-agent:" + deck.as_uri()) + "," + json.dumps(pair["token"]) + ");"
        cdp.call("Page.addScriptToEvaluateOnNewDocument", source=script)
        cdp.call("Page.navigate", url=deck.as_uri())
        sessions = []
        for _ in range(80):
            sessions = bridge.call("/sessions")["sessions"]
            if sessions:
                break
            time.sleep(.2)
        assert sessions, f"file:// did not connect: {cdp.errors}"
        sid = sessions[0]["sessionId"]
        snapshot = bridge.call("/request", {"sessionId": sid, "kind": "read"})
        assert snapshot["doc"]["docId"] == doc["docId"]
        request = {"id": "browser-edit", "docId": doc["docId"], "agent": "Integration test", "patches": [
            {"path": ["slides", {"id": "first"}, "elements", {"id": "title"}, "html"],
             "before": "Before agent edit", "value": "Live edit arrived"},
            {"path": ["slides", {"id": "second"}], "value": {**doc["slides"][0], "id": "second", "elements": []}},
        ]}
        payload = {"sessionId": sid, "kind": "patch", "request": request}
        result = bridge.call("/request", payload)
        assert result["status"] == "applied", result
        assert cdp.eval("window.tessera.doc.slides.length") == 2
        assert cdp.eval("document.querySelector('.ed-stage-scale').textContent.includes('Live edit arrived')")
        assert bridge.call("/request", payload) == result
        assert cdp.eval("window.tessera.doc.slides.length") == 2
        request = {**request, "id": "stale", "patches": request["patches"][:1]}
        assert bridge.call("/request", {**payload, "request": request})["status"] == "conflict"
        assert cdp.eval("window.tessera.agent.read().dirty") is True
        cdp.eval("window.tessera.undo()")
        assert cdp.eval("window.tessera.doc.slides.length") == 1
        assert cdp.eval("document.querySelector('.ed-stage-scale').textContent.includes('Before agent edit')")
        cdp.eval("window.tessera.redo()")
        assert cdp.eval("window.tessera.doc.slides.length") == 2
        # A focused input defers work; after a real input event, stale notes conflict.
        # The notes field lives in the right column, behind its Notes tab.
        cdp.eval("document.querySelectorAll('.ed-side-tab')[1].click()")
        cdp.eval("document.querySelector('.ed-notes-input').focus()")
        notes = {"id": "notes", "docId": doc["docId"], "agent": "test", "patches": [
            {"path": ["slides", {"id": "first"}, "notes"], "before": "", "value": "agent notes"}]}
        note_payload = {"sessionId": sid, "kind": "patch", "request": notes}
        assert bridge.call("/request", note_payload)["status"] == "busy"
        cdp.eval("(() => {const el=document.querySelector('.ed-notes-input');el.value='Human notes';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.blur()})()")
        assert bridge.call("/request", note_payload)["status"] == "conflict"
        assert cdp.eval("window.tessera.doc.slides[0].notes") == "Human notes"
        # Re-created service state simulates a restart; the editor keeps receipts.
        server.bridge = bridge.Bridge()
        for _ in range(40):
            if bridge.call("/sessions")["sessions"]:
                break
            time.sleep(.2)
        assert bridge.call("/request", payload)["status"] == "applied"
        assert cdp.eval("window.tessera.doc.slides.length") == 2
        assert cdp.eval("(async()=>{const html=await window.tessera.serialize();return html.includes('Human notes')&&!html.includes(" + json.dumps(pair["token"]) + ")})()")
        cdp.shot(ROOT / "testing/agent-live.png")
        cdp.eval("window.dispatchEvent(new Event('tessera-file-target-changed'))")
        assert cdp.eval("localStorage.getItem(" + json.dumps("tessera-agent:" + deck.as_uri()) + ")") is None
        assert not cdp.errors, cdp.errors
        print("PASS file:// pairing, authenticated HTTP, redraw/insertion, retries, conflicts, undo/redo, active typing, reconnect, credential-free serialization, save-target disconnect")
    finally:
        if cdp:
            cdp.ws.close()
        if proc:
            proc.terminate()
            proc.wait(timeout=10)
        server.shutdown()
        server.server_close()
