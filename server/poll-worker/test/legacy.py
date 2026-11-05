"""Decks written before the rename use these names.

The old names an activity page and a phone used, for test/live_browser.py:
an old game page must still get its device token, and a phone that stored its
token under the old key must keep it (public/legacy.js, src/legacy.js).
"""

OLD_DEVICE_KEY = "bento-device"

# A game page as it was written before the rename: the old meta, the old
# global and the old header.
OLD_GAME_PAGE = """<!doctype html><meta name="bento-game"><body><div id=g>-</div><script>
  var a = window.BENTO_ACTIVITY || {};
  fetch('/api/game?c=' + a.code, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bento-player': a.player },
         body: JSON.stringify({ code: a.code, op: 'join', name: 'Old phone' }) })
    .then(function (r) { return r.json(); })
    .then(function (d) { document.getElementById('g').textContent = JSON.stringify({ player: a.player, pid: d.pid, sdk: typeof window.BentoGame }); });
</script></body>"""
