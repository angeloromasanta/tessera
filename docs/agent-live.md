# Live agent editing

Agents can read and change an open local deck without reloading it. The open
editor is authoritative and writes the deck file (through its file handle, or
through the bridge's `/save`); a file write that reached the disk behind its
back is folded into it, never overwritten ("Saving" below). Accepted changes
use the ordinary store, rendering, recovery and tab-to-tab sync paths.

## Setup and lifecycle

1. Build the fork and upgrade the chosen deck with `scripts/upgrade-deck.mjs`.
   Save any open work first; an already-open old shell needs one reopen. The
   template already includes the bridge.
2. Open the deck from disk. **Nothing to paste:** a `file://` deck probes the
   bridge (every 2 s, backing off to 5 s) and, once it runs, claims its own
   per-file token from `POST /claim`. Any CLI command (`slide.py`, `agent_live.py`)
   starts the bridge, and `slide.py` waits up to 6 s for the editor to arrive.
   The token only lets a page act as that deck's editor, and only the editor ever
   writes the file, so the paste step bought nothing. `agent_live.py pair FILE`
   still registers a file and prints its token as a fallback.
3. No connection status is shown. What the person sees is the work: a slide an
   agent patches gets a thumbnail ring for 5 s, a request being worked on
   shows a pulsing dot, the canvas chip "{agent} is updating this slide" and
   the top bar's "{agent} is working on N requests" (the name is the agent's
   own, from its edits or replies), and hovering a waiting dot says "no agent
   listening" while no listener is there. Save ▾ → **Pause agent edits** turns agents off for that
   file (remembered) and on again. `agent-bridge.ts` only reports
   (`tessera-agent-status`, `tessera-agent-listening`).
4. Agents use `sessions` to discover the open editor. Several tabs of one file
   that share a `docId` are one deck (they sync over BroadcastChannel): a
   command addressed to any of them goes to ONE of them, the selected tab or a
   sticky primary (`Bridge.session`). Tabs of one file holding different
   `docId`s still require `select <sessionId>`; never guess which owns the work.
   `slide.py DECK.html ...` routes to the deck's open editor by itself.
5. A stale token (bridge state reset) is refused with 403; the editor drops it
   and claims again. `agent_live.py stop` stops the service without clearing
   tokens or source guards.
6. The bridge runs for days, so a new `agent-bridge.py` is not live until the
   running one is replaced: `start()` (every CLI call) asks `/sessions` for its
   `version` and, when it is older than `VERSION`, stops it and starts the new
   one. Open tabs reconnect within a second; an in-flight `/wait` or `/request`
   of that moment errors once.

Save As or switching document identity disconnects the bridge: open and pair the
intended saved file before resuming. A browser file handle does not disclose its
absolute directory; session paths identify the opened file, not an independently
verified save destination. Choose that same file in the initial save picker.

The bridge listens only on `127.0.0.1:18765` (tests run their own with
`TESSERA_AGENT_PORT` and `TESSERA_AGENT_STATE`; the shell only knows 18765, so a
browser test forwards it by route interception). Port 5174 is already used by the local
Vite server. Runtime state and the log live in `%LOCALAPPDATA%/TesseraAgent/` (or
`~/.local/share/TesseraAgent/` on other systems). CLI and per-file editor tokens are
separate. Only authenticated `file://` editor requests get CORS access; the CLI
interface rejects requests with an Origin header. Hosted decks never
auto-connect. The deck remains usable with the bridge stopped.

Browser-local network or file-write permission prompts, when required by browser
policy, cannot be bypassed. A first save may still need a file picker. Routine
agent edits never need a refresh.

## Agent commands and patch format

```powershell
python tools/agent_live.py sessions
python tools/agent_live.py read <sessionId> --out slides/<deck>/build/live.json
python tools/agent_live.py patch <sessionId> slides/<deck>/build/change.json
python tools/agent_live.py result <sessionId> <requestId>
```

`read` returns `{doc, dirty, currentSlideId}`. It omits any legacy `collab` field.
Use this live document's theme, layouts, stable IDs and content. Do not use a stale
disk copy. Store working snapshots and patches under the deck's `build/` folder.

Example `change.json`:

```json
{
  "id": "a-unique-request-id",
  "docId": "the-docId-from-the-live-read",
  "agent": "Slide writer",
  "patches": [
    {
      "path": ["slides", {"id": "s01"}, "elements", {"id": "title"}, "html"],
      "before": "Previous title",
      "value": "Revised title"
    }
  ]
}
```

- String path segments address object properties. `{"id":"…"}` selects an
  array member by stable ID. Numeric array offsets are deliberately unsupported.
- Omit `before` only when the property/member must not exist. Omit `value` to
  delete it. `null` is an actual value, not absence. A removed node must match the
  complete `before` object, so unseen changes cannot be deleted accidentally.
- Insert a slide with `path:["slides",{"id":"new-id"}]`, no `before`, and the
  complete slide as `value`. It appends. New polls need fresh question codes;
  state slides may intentionally reuse the parent question.
- To reorder, use `{"path":["slides"],"order":true,"before":["s01","s02"],
  "value":["s02","s01"]}`. Orders contain all current IDs; in a multi-operation
  batch they describe the state after preceding operations. Element order uses
  the path to the slide's `elements` array. Concurrent structural changes may
  conflict and require a fresh read.
- Supported roots: `slides`, `assets`, `title`, `theme`, `layouts`, `fonts`.
  Address individual slides/assets/layouts rather than replacing collections.
  An absent assets/layouts container can first be initialized to `{}`/`[]`.
  Legacy `collab`, document identity, the global poll session and node IDs are protected.
- Include any new assets in the same transaction as the elements using them.
  Preserve IDs across morph-related slides. Never introduce a whole-document
  `loadDoc` call to accomplish a live edit.

Transactions apply atomically and check previous values immediately before
commit. Separate fields can change independently; the same field conflicts.
Typing, dragging, dialogs and presentation mode return `busy`; retry after the
gesture finishes. `conflict` needs a new read and a newly considered patch, never
blindly replacing its `before` value. Invalid/read-only requests change nothing.

**Redraw scope.** An accepted edit redraws only the slides it changed: their
thumbnails, plus the canvas when the open slide is one of them. Untouched slides keep their object identity and their DOM, so a figure
running on the open slide is not reloaded by an edit elsewhere. Everything is
redrawn when the change reaches further: theme, layouts, fonts, title, slide
order or count, a slide carrying a poll, or a replaced asset the theme, layouts
or fonts name. `AgentEditor` publishes the set as `store.scope` for the
duration of the notification (`null` = anything), and listeners that skip work
must read it there. Human edits and undo still redraw every thumbnail.

Successful request IDs are remembered for the lifetime of the open editor.
Retry an uncertain delivery using **the same ID, payload and session**. Reusing
an ID for different content is rejected. After a reload, inspect the live document
before retrying: request deduplication does not promise persistence across reloads.
The editor refuses further new requests at 10,000 accepted transactions rather
than evicting deduplication records. Reopen and rediscover for a new session.

The scripting surface is `window.tessera.agent` (`version`, `sessionId`, `read`,
`apply`); it uses the same validator as the bridge. This does not change browser
automation permissions. Prefer the CLI for agent work.

## Change requests

The person asks in the editor's review list: a field beside every slide
(that slide), the "Whole deck" row first (the deck: flow, tone, a new
section), and on a new empty slide its field asks "What should this slide
be?" (a request on that slide). A dot before each comment shows its status
(hollow waiting, pulsing working, green done, and the comment turns green)
and hovering it shows the agent's reply, so the reply is what the person
reads: one line on what changed. Any agent can serve them; nothing here is specific to one tool.

**Data.** A slide's request is an entry of `slides[i].comments` with
`request: true`; a whole-deck one is an entry of the top-level `requests`
array (added 2026-10-28; older shells keep it unread). Both are
`{id, text, author, at, status: "open"|"working"|"done", elementId?, elementIds?,
replies?: [{id, author, text, at}], resolved?}`. They save with the file, sync
between tabs (`doc.requests` as one last-writer-wins register), and are
patched like any other field (`requests` is a patch root). A request on an
empty slide asks the agent to build that slide where it sits. Canvas comment
markers skip requests. A recompile (`md_to_deck.py`) carries slide requests
over by slide id.

**Serving one.** Set `status: "working"`, make the change, append a reply
(author = the agent's own name) and set `status: "done"`, `resolved: true`.
Never delete a request; the person deletes their own.

**Edited or stopped by the person** (shells built 2026-11-05 on). Clicking a
sent request's text edits it: `text` is replaced, `rev` goes up by one and
`editedAt` is set. A waiting request just has the new text; one being worked
on stays `working` and the agent adjusts to the new text; a done or stopped
one goes back to `open` (its `resolved` and `stoppedAt` dropped). While a
request is `working` its delete button is Stop: it sets
`status: "stopped"`, `resolved: true` (an older shell shows it as done) and
`stoppedAt`. The agent stops, lands nothing more for it and does not resume
it. A later reply is kept but does not change the status
(`slide.py reply` and `window.tessera.requests.reply` both keep the stop).
Both wake listeners through `pendingIds` (below).

**Protocol additions** (all on the bridge above):

| where | field / route | meaning |
|---|---|---|
| editor → `/tick` body | `pending: <int>`, `pendingIds: [id…]` | `pending` counts requests with status `open`. `pendingIds` lists the open ones (ids from shells built 2026-10-22 on), and from 2026-11-05 also each edited request as `id@rev` (open or working) and each request stopped in the last 10 minutes as `id!stop`, so an edit or a stop wakes a listener once |
| `/tick` response | `listening: <bool>`, `saveVersion: 2` | a listener is waiting for this file (a waiting request no longer says "no agent listening"); the bridge takes the raw `/save` below |
| CLI `POST /wait` | `{file?: "file:///…", timeout: <=25, listener?: name}` | blocks until a live session (of that file, or any) has an open request THIS listener (key: `listener`, else the file) was not told about yet; returns `{sessions, new: [ids]}` or `{sessions: [], timeout: true}`. Each id is reported once per listener, so re-arming while the agent is still on the last request does not fire again at once. A shell that sends only the count gets one report per rise of the count. Each call keeps the listener present for 30 s, so call it in a loop |

The editor never counts the request field as a busy gesture: typing the next
request does not hold up a patch.

**Clients.** `agent-bridge.py wait [FILE]` is the raw call. The skills' wrapper:

```powershell
python tools/slide.py requests DECK.html            # open requests ([deck] = whole deck)
python tools/slide.py requests DECK.html --wait     # background listener; exits on new ones
python tools/slide.py reply DECK.html REQ_ID "what I did" [--status working]
```

In the page itself: `window.tessera.requests.list({open: true})` (a whole-deck
request has `slideIndex: -1`, `slideId: ""`),
`.reply(id, text, status, agentName)`, `.pending()`, `.onChange(fn)`. Each
request the box sends also fires `window` event `tessera-request`
(`detail: {slideId, request}`, `slideId` empty for the whole deck), for a hosted page with no bridge that must
carry it to the file itself (the phone view uses the same box, `OVERVIEW.md`). A deck
that is not open anywhere still carries its requests in `#tessera-doc`; an agent
reading the file finds them there (the shell's head comment says so).

## Saving, undo and Markdown

**The deck is always saved.** About 0.8 s after any change (a person's edit, a
deleted slide, an agent patch) the editor writes the file: through its file
handle when it holds one, otherwise through the bridge's `POST /save`. The
bridge replaces only the `#tessera-doc` block of the file on disk (the shell on
disk is kept, it may be newer than the tab's), under the same lock file
`slide.py` takes but outside the bridge's own lock (a 15 MB save does not stall
other tabs' ticks or an agent's commands), atomically, and does not rewrite a
file whose block is already identical. For a deck with a sibling `.md` spec it
also writes the live-source guard, since the file now holds edits the spec
lacks. Leaving the tab writes at once. There is no "unsaved" state to manage:
browser version history undoes. `canSave` in `sessions` is true once the
editor saves (handle or bridge), and `slide.py` then skips its own
write-through. Edits arriving during a save trigger another save.

**A save never overwrites a file it did not see** (2026-10-22). Each save
names the file version it is based on: `base` = SHA-256 of the block content,
CRLF→LF and trimmed (`version_token` in the bridge, `versionToken` in
`agent-bridge.ts`). The tab hashes the block it booted from; after that the
bridge returns the new token with every save. When the file holds anything
else (slide.py wrote it while this tab was not counted live — agents switched
off, a throttled background tab —, a recompile, another tab), the bridge
answers **409** `{conflict, token, doc}` and writes nothing. The editor then
folds the file's changes in (`save-merge.ts`): the patches from its base to the
file (`diff`, `agent-patch.ts`) are applied compare-and-set to its own
document, so a change lands wherever the tab still holds the base value; on a
field both changed the tab's version is kept and a toast names it ("The file
changed on disk: …"). It adopts the file's version as its base and saves the
union. A file without a `docId` (recompiles strip it) is protected the same
way; the tab's `docId` goes back in. A file that now holds another deck (a
different `docId` from both the base and the tab) is refused, not merged.

Wire forms of `/save` (editor capability, `Origin: null`):

| shell | body | identity |
|---|---|---|
| built 2026-10-22 on, bridge says `saveVersion: 2` | the file itself, `Content-Type: text/html`, sent as a Blob of the serializer's pieces | query `?file=&docId=&base=` |
| older shells, or an older bridge | JSON `{file, docId, html}` | in the body; no base: accepted as before (docId check only) |

So already-shipped shells keep saving, but without the base check: they can
still overwrite a file written behind their back until they are re-hosted.

Undo/redo conditionally reverse only changed properties and ID-addressed nodes.
Unrelated subsequent edits survive. If targeted content has changed again, undo
refuses the entire reversal and shows a conflict notice. This changes legacy
whole-document undo deliberately; structural order conflicts are conservative.

**Write-through.** An editor that has not been saved since it was opened holds no
file handle (`canSave: false` in `sessions`), so its edits live only in the tab;
a reload restores the stale file (this lost a session's work on 28 Sep 2026).
`slide.py` therefore reads the whole live document after each patch and writes
it into the file (keeping the file's `collab`), whenever the session cannot save.

The first live **patch** creates `build/<deck.html>.live-source.json` (merely
opening or connecting a deck does not). This guard persists after the bridge
stops, and the spec compiler and `deck_build.py` refuse to overwrite that
target. `slide.py` does not: it edits the open editor when there is one and the
file when there is none. During live work, the **live deck is authoritative**, even
when it originally came from Markdown. Figure files remain independently live.

Before a later full compile: save the live deck, reconcile its changes into the
Markdown, disconnect the editor, and explicitly acknowledge that reconciliation:

```powershell
python tools/agent_live.py reconcile slides/<deck>/<deck>.html --acknowledge
```

The command refuses while the editor still has a live heartbeat (allow six seconds
after disconnecting). It records an author's acknowledgement, not automatic proof
that Markdown represents arbitrary browser edits. It never rewrites the source.

## Validation and limitations

From `tessera/`:

```powershell
node scripts/test-agent.mjs
python scripts/test-agent-bridge.py
python scripts/test-live-request.py
python scripts/test-agent-browser.py
node --experimental-strip-types scripts/test-sync.ts
```

The browser test uses a separate headless profile, temporary fixture and isolated
bridge state; port 18765 must be free. It verifies real file-to-localhost pairing,
read/patch, visible redraw, slide insertion, duplicate delivery, conflicts and
undo/redo. It does not open the user's Chrome profile.

Manual acceptance: pair a selected upgraded deck; keep a slide selected while an
agent edits another; observe the thumbnail and canvas update without refreshing.
Type into a text box while an agent submits a change, then finish editing; stale
text must conflict. Save/reopen and verify persistence. Stop/restart the bridge
and verify reconnect. A second tab of the same deck should receive the accepted
edits.

This version targets the editor and local agents. It does not refresh an ongoing
presentation, round-trip all browser edits into Markdown, or add a remote agent
service. Other tabs of the deck keep the CRDT semantics; the stricter
compare-and-set protection applies at this receiving editor's commit boundary.
