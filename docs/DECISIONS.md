# Decision log

Append-only. Newest first. One entry per settled decision that a parallel
agent (or future session) might otherwise re-open or contradict. Keep entries
to a few lines: **what** was decided, **why**, and where the details live.
Reversing a decision = a new entry that supersedes the old one, not an edit.

Format:

```
## YYYY-MM-DD — Title
Decision. Why. Pointers.
```

---

## 2026-11-04 — Renamed to Tessera; formats renamed; the public layout
The project is now Tessera (forked from bento, nyblnet/bento, MIT). Formats were
renamed: `#tessera-doc` (`application/tessera+json`), `TesseraGame` and
`<meta name="tessera-game">`, the `x-tessera-player` header, `tessera-device`,
`tessera-*` storage keys, `TESSERA_EMBED` / `TESSERA_STEPS`. Readers accept the
old names through `legacy.*` modules (decks written before the rename keep
working, storage is copied old to new once and the old keys left untouched);
writers write the new names. The build is `slides/dist-single/tessera.html`. The
brand template moved out of the public tree; the public template is a neutral
`template.html` whose layouts resolve by role. The authoring tools and guide
moved into the repo (`tools/`, `kit/`, `docs/guide/`), and the poll service is
deployable by anyone with `npm run setup` (`docs/server-setup.md`). Older
entries below keep the names that were current when they were written, rewritten
here to the new names where a path or identifier is still live.

---

## 2026-09-28 — An open question is one slide: the hive, its poll hidden beneath
The poll + hive pair showed every open question twice. `sl-poll-hive` now
carries its own `poll` (`opacity: 0`, under the embed); `precedingPoll` already
counts the embed's own slide, and a slide with a poll publishes it to the
phones. The compiler and `add-poll` build this for every open question
(`hive: no` / `--no-hive` for the classic slide). Supersedes "copy both slides
together". Details: `template/README.md`.

## 2026-09-28 — Embeds are told the poll before them (`TESSERA_EMBED.poll.previous`)

A results figure used to hard-code the bucket code it reads. Template
instantiation remints every poll code, so the clustered-hive slide shipped in
`template.html` would have read an empty bucket in every deck made from it. The
renderer now passes the nearest poll at or before the embed's slide
(`precedingPoll`, `slides/src/render.ts`). Only code, kind and question — not
the document — so the sandbox boundary is unchanged. The preamble JSON now
escapes `<`, since the question is free text.

## 2026-09-07 — `allow-same-origin` is honoured for a cross-origin `src` embed

`embedSandbox` refused the token unconditionally. That was one rule doing two
jobs, and it got the second one wrong: in a sandbox `allow-same-origin` does not
mean "same origin as the parent", it means "keep your OWN origin instead of an
opaque one". For an `asset`/`html` embed — rendered through `srcdoc` — that own
origin IS the parent's, so granting it hands the frame the document and the
E2EE room keys it carries; the refusal is exactly right there and stays. For a
frame loading `https://www.youtube.com/embed/…` the own origin is YouTube's,
and the parent is no more reachable than before.

The blanket refusal therefore bought nothing on third-party URLs and cost every
hosted player: YouTube, Vimeo and anything else that needs storage for its own
origin boot to a blank rectangle under an opaque origin. Verified in Chrome —
same iframe, sandbox on renders black, sandbox off plays. Two decks had already
worked around it (two course decks), each with a slide that was
a picture of a video.

So the token is now passed through when the element asks for it AND the frame
is loading a cross-origin http(s) `src` (`embedIsThirdParty` in
`slides/src/render.ts`). Inline pages, relative URLs, same-origin URLs and
non-http schemes are refused as before — `data:`/`blob:` get an opaque origin
regardless, so allowing them would only widen what has to be reasoned about.
The deck still decides: nothing is granted unless `sandbox` lists it.

## 2026-09-01 — The template generator is deleted; the file is the only source

`scripts/build-template-deck.mjs` is gone. It bootstrapped `template.html` once and
was never wired into a build — no npm script ran it, nothing imported it, and
its own header said re-running it was wrong. Keeping a script whose documented
modes (`--force`, `--layouts`) silently discard template work, next to a file
that is the source of truth, is a trap for the next agent rather than a
capability. Supersedes the 2026-08-12 entry below: of the three paths it named,
only `upgrade-deck.mjs` survives.

Consequence worth knowing: **`doc.layouts` is now owned by the file.** The old
entry warned that hand-added layouts would be dropped by the next `--layouts`
run; nothing does that any more, so "Save slide as layout" and JSON splices are
both permanent. `scripts/build-flow-slide.mjs` already relied on this.

Recovery, if a from-scratch rebuild is ever wanted: `git log --
scripts/build-template-deck.mjs`. Font re-embedding, which was its `--force`
path, is now a hand-edit — recipe in `scripts/brand-fonts/README.md`.

---

## 2026-08-12 — Agent instructions live in the DOCUMENT (`doc.agentNotes`)

The head's `AI AGENTS / TOOLING` comment belongs to the SHELL, and both update
paths (`src/update.ts`, `scripts/upgrade-deck.mjs`) keep only `#tessera-doc` and
throw the rest of the file away — so anything written into that comment is lost
the first time a deck is updated. Fork- and template-specific briefing
therefore goes in an additive top-level `agentNotes` (array of strings),
inserted right after `title` so JSON.stringify's insertion order keeps it in
the first KB of the file, where an agent reading the head finds it without
parsing. The app ignores the key; `parseDoc`/`asTemplateFile` preserve it.

Text lives in `scripts/template-agent-notes.mjs` and is stamped onto a deck by
`scripts/stamp-agent-notes.mjs`. The shell comment now points at it ("if the
document has agentNotes, read that first"), so the two cannot drift into a
contest. **Never write the six characters backslash-u003c inside a note**: every
reader unescapes the block with `.replace(/\\u003c/g,'<')` and would eat the
tail of the doubled backslash JSON.stringify emits.

## 2026-08-12 — Authoring tools are a hub (`deck`) plus three spokes (later folded into `tools/`)

The authoring skills were two where `figure` reached into
`pptx-to-deck/tools` for the compiler. The shared pieces (`md_to_deck.py`,
`deck_build.py`, `shoot.py`, `agents.md`, `hand-editing.md`) now live in a new
`deck` hub alongside `reference/TEMPLATE.md` (the layout catalog);
`pptx-to-deck` keeps only `pptx_*.py`; `engage` is new and owns polls,
quizzes and `activity` pages. Install all four together — the spokes address
the hub as `$SKILL/../deck`. The no-tools guide is the
no-tools version of the same knowledge (now `docs/guide/`), to be copied next to a deck.

Two real bugs fell out of the audit: `md_to_deck.py` cloned the template's
`docId`, `collab` and `poll.session` verbatim, so every deck compiled from
`template.html` joined the template's live sync room and its audience session
(now stripped and re-minted at compile time); and spec keys the parser doesn't
know are treated as prose and glued onto the previous field, which silently
corrupted `kind:` when `activity:`/`requirename:` were added — new poll fields
must be added to `KEYS`.

## 2026-08-12 — Save picks the file BEFORE it serializes

`saveFile` opened the save picker after building the HTML. `showSaveFilePicker`
needs transient user activation, which expires ~5s after the keypress, and
serializing a big deck (clone the DOM, stringify a document with embedded
fonts, escape it, re-serialize) can outlast it — so the picker threw
`NotAllowedError` on exactly the decks that matter and the editor reported
"Save failed". Everything needing activation now happens first: the picker, and
`queryPermission`/`requestPermission` on a held handle (a lapsed readwrite
grant was the second, independent source of the same error — it made the silent
autosave write-back fail forever with nothing to click). A refused write falls
back to a download rather than throwing: a save must not dead-end. The autosave
timer checks the permission WITHOUT prompting — an unprompted request is
rejected anyway, and a permission dialog 2.5s after someone typed is worse than
a quiet skip. `writeUpdatedFileAs` takes a THUNK so share exports pick their
file before serializing too. Details in `kernel/src/save.ts`.

---

## 2026-08-12 — A template's file is the source of truth; the generator only bootstraps it

`scripts/build-template-deck.mjs` OWNS the document it writes, so re-running it
after the template had been edited in the app silently discarded that work.
Generators now refuse to overwrite an existing file. Three explicit paths
instead: `upgrade-deck.mjs` (keep the document, swap the app shell — the usual
one, and the same splice contract as the in-app self-update), `--layouts`
(replace `layouts` + `theme`, fill in missing assets, keep the author's
slides), `--force` (regenerate, `.bak` first).

The other half of the same problem: opening a template CONSUMES `template:true`
(`parseDoc` strips it — that IS the instantiation), so saving an edited master
template quietly demoted it to an ordinary deck, and every later opener would
have inherited one `docId`, one live room and one poll session. Template-ness
is now a toggle in About → Document properties, and both write paths serialize
through `model.asTemplateFile` (flag on, `docId` + `collab` stripped) so the
open copy keeps its own identity while the file stays a template.

---

## 2026-08-12 — The poll deployment lives in the document, not in the app

`DEFAULT_POLL_HOST` was a hard-coded deployment URL in `slides/src/model.ts`,
which made every shell built from this repo a client of one particular server
and put a brand into the kernel of a general-purpose app. It is now empty by
default and set per build (`POLL_HOST=… npm run build:single`), with a new
document-level `doc.poll.service` above it in the lookup: element `service` →
`localStorage['tessera-poll-url']` → `doc.poll.service` → build default. The deck
carries its own deployment, so a template hands a working poll service to every
deck forked from it and a file keeps working when opened on somebody else's
shell. With nothing configured the slide says so where the join address would
be, and the client refuses to fetch — an empty host would otherwise build
RELATIVE urls and quietly ask whatever server the file was opened from.

---

## 2026-07-26 — Audience polls: a `poll` element plus a service that holds the key

A new element type (`poll`) and a small service (the legacy service, no longer shipped).
The presenter shows the slide, the room answers from their phones, and one
button turns the answers into themes on the slide.

**Why a server at all**, when the whole premise is that the file is the
app: the summarizer needs a model API key, and a deck file is a public,
shareable document — a key inside one is a key you have given away. So the deck
sends a join code and gets prose back. Same reasoning keeps the Firebase SDK
out of the shell (size) and the QR encoder out of it too (rendered by
`/api/qr`; upstream dropped a 630KB chart library for size and a runtime QR
encoder is not how to spend that back).

**Only the summary is written back into the file.** Raw answers stay in the
service. A deck you reshare should record what the room said without carrying
every individual response along with it, and answer text is not yours to
redistribute by accident.

**The element renders statically everywhere** (question, join URL + QR, saved
summary); the live parts exist only in present mode — the same split that keeps
`media` from autoplaying on the canvas. A poll slide must open, print, and
present with no network.

**A copied poll gets a fresh join code** (`remintPollCodes`, called from layout
instantiation, paste, and duplicate; a state slide is the deliberate exception).
Two slides sharing a code silently pool their answers into one poll, which is a
miserable thing to discover from the stage; an unwanted second code is visible
in the panel and trivially undone.

Details: `docs/format.md` §`poll`, the legacy service's README (including why
its database rules were open and what caps compensate).

## 2026-07-26 — A language pack lives in the FILE and nowhere else

No browser-local install. A "keep it on this computer" option (localStorage)
was **built and then removed**, because `localStorage` is scoped per ORIGIN
and that is fatally misaligned with how the app is used: the download comes from
a website (an https origin) and the file is then opened from disk (a
`file://` origin). A language added on the website was therefore GONE the
moment the user saved the deck and reopened it locally — the exact journey the
product encourages, and "I added Korean and it vanished" is not a bug a user
can diagnose.

One home also matches the platform: the file *is* the software, so a language
belongs to the deck. The trade — adding a language requires saving the file —
is stated plainly in the UI ("Added when you next save") rather than hidden.
Adding is staged on click and written on the next save because on browsers
without File System Access, writing on click means silently downloading a
second copy of the user's deck.

Corollary: anything that remembers pack *content* outside the file
reintroduces this. Viewer *preferences* (locale, reduce-motion) stay
browser-local on purpose; that asymmetry is deliberate. Details:
`docs/i18n-packs.md`, `slides/src/packs.ts`.

## 2026-07-26 — The pack carrier is generic; pack POLICY is not. This is not a plugin system.

The kernel mechanism is already extension-agnostic and should stay that way:
`registerShellBlocks` / `readShellBlocks` (`kernel/src/save.ts`) carry
arbitrary typed blocks in the shell and know nothing about languages, and
`registerUpdatePrepare` (`kernel/src/update.ts`) is a generic "refresh
version-bound extras" hook. Signature verification and hash pinning are being
made generic in the kernel too (branch `claude/i18n-pack-verify`). Reuse all
of that freely.

**Do not generalize the policy.** Language packs are DATA and their worst case
is bounded — a tampered or stale pack shows wrong or English words. That bound
is why degrade-per-string, keep-on-refresh-failure, and auto-refresh on update
are the right rules *for packs*.

Anything carrying CODE is categorically different: unbounded failure (it would
hold the document, the file handle, and the collab keys), and it breaks the
property that makes self-update trustworthy — that the shell only ever runs
bytes from a signed release. Such a thing would need its own policy (pinned at
install, never auto-refreshed) and must not inherit the pack rules by reusing
the pack machinery.

So: reuse the carrier and the crypto; do not treat "we have packs" as evidence
that a plugin system is designed or wanted. It is not.

## 2026-07-26 — Side-loaded artifacts: sign the index, pin the bytes, fail closed

Language packs are fetched over the network, so they get the **same two-step
the app shell's own update already gets**: an envelope signed with the release
key (`{payload, sig}`, ECDSA P-256 / SHA-256) whose payload pins each
artifact's `sha256`, and a download that is accepted only if its bytes hash to
that pin. Signature over the pin, pin over the bytes. **No second key and no
second trust root** — `PUBLIC_KEY_JWK` in `kernel/src/update.ts` is it.

The mechanism lives in the kernel (`verifySigned`, `fetchPinned`) because it is
the same for anything side-loaded; the *policy* stays in the app
(`slides/src/packs.ts`). Keep that boundary: the kernel helpers verify BYTES,
they do not decide what is safe to use. Packs are DATA with a bounded failure
mode (wrong words on screen), which is why a pack that fails a refresh is kept
at its existing version rather than dropped. Anything side-loaded that ever
carries CODE needs stricter policy — pinned at install, never auto-refreshed —
and must not inherit the pack rules by reusing the same fetch.

**Fail closed, no legacy path.** An unsigned or unpinned index yields no
listings at all. Nothing is published yet, so there is no permissive fallback
to keep — and one added later would mean whoever answers for the channel picks
the strings in the UI.

**A pack already inside a file is NOT re-verified** (`readPacksFromShell`). It
was verified at the door, and once spliced it carries exactly the trust the
document does — anyone who can rewrite that block can rewrite the checking
code too. Re-verifying would need the network at boot, which breaks offline
use. Proof rig: `node scripts/test-packs.ts` (throwaway key, real crypto).

## 2026-07-26 — Language packs are published under a SIGNED INDEX, separate from the manifest

Amends the "Signing and release" paragraph of `docs/i18n-packs.md`, which said
the update manifest would gain a `packs` array. It does not.

`release.mjs` emits the packs and signs **one index** over all of them at
`releases/slides/packs.json` — the same `{payload, sig}` envelope, the same
offline key, and literally the same signing code as the manifest (extracted to
`scripts/sign-payload.mjs`). Each listing pins its pack's `sha256`; individual
packs are not separately signed. Clients verify the index once, then hash each
download against its signed hash.

Why not inside the manifest: shipped files ignore a manifest that is not
strictly newer than themselves (downgrade-replay protection), so pack hashes
carried there could never be corrected **between** app releases — and a fixed
translation is not a new app version. A separate index is re-issuable any day,
and `manifest.json` keeps meaning exactly one thing: here is the app shell.
Signed code and signed data stay two artifacts.

Still one key, still local-only signing, and `publish-site.mjs` now gates the
index the way it already gates the shell (indexed pack missing, hash drifted,
or packs staged with no index = refuse to publish). Details and the exact
payload shape: `docs/i18n-packs.md` §"Signing and release"; `scripts/sign-packs.mjs`.

## 2026-07-25 — i18n: a bundled core of 9 languages, everything else a signed pack

The 7 non-English catalogs cost **115,572 B** of the shell even after key-once
packing — more than any dependency, and an English-only shell is 28.8%
smaller. But we want *more* languages, not fewer. So: **bundle a core, ship
everything else as signed downloadable packs.**

- **Bundled (9):** the existing 8 (en, ja, zh-Hans, zh-Hant, es, fr, de, it)
  plus **Portuguese**. Nothing regresses for current users; Portuguese is
  added because Brazil has a real English-proficiency gap and it is in the
  cheapest cost tier.
- **Everything else:** a pack, signed with the existing release key and
  released centrally alongside each app release, fetched only on explicit user
  action and spliced into the file.

**No further languages get bundled by default** — demand declares itself
through contributions (#17 offers Korean), and a pack can be revised without
cutting an app release.

Measured facts worth not re-deriving: cost is **~14 KB per language regardless
of script** (CJK is the *cheapest* — 2.6× the bytes per character but a third
of the characters). Simplified↔Traditional conversion on the fly does **not**
pay: only 43.3% of characters match, because the difference is vocabulary
(软件/軟體) not glyph form, and deflate already recovers the genuine redundancy.
Rank candidate languages by the **English-proficiency gap in the segment that
uses this tool**, not by speaker counts — which is why Hindi is not in the core
despite 610M speakers.

Full design, risks and status: **`docs/i18n-packs.md`**. The risk that will
ship broken if ignored: **self-update must carry packs forward** — `update.ts`
re-splices the document into a *new shell*, and packs live in the shell.

## 2026-07-25 — Every PR gets human review before merging to main (for now)

At this stage of development the maintainer reviews **every** PR before it
lands on `main`, including agent-authored ones. No auto-merge. The point is
visibility into what the agents are actually producing while the multi-agent
workflow is still being shaken out — the cost is throughput, and that is
currently the right trade.

Supporting config, already in place: `main` is branch-protected with one
required approval, and CI (`validate`) is a **required status check**, so a red
build cannot merge. Admin bypass stays enabled for the maintainer.

### FUTURE ACTION — revisit when review becomes the bottleneck

When PR volume outgrows one reviewer, consider auto-merging **app-zone** PRs on
green CI. If that happens, these paths must **always** require human review
regardless, because a bad merge is either silent or catastrophic:

- **`kernel/src/`** — every app depends on it.
- **`slides/src/sync/`, above all `crdt.ts`** — convergence bugs are silent and
  corrupt documents. The rig is necessary but not sufficient: it only generates
  short strings, which is why it missed the large-text stack overflow (#47).
- **`server/`** — one bad deploy breaks live collaboration for everyone at
  once, and there is no per-user rollback.
- **`scripts/release.mjs` / `sign-release.mjs` / `keygen.mjs`** — the signing
  and release path.
- **Anything touching the `#tessera-doc` splice contract or the update-manifest
  shape** (`PLATFORM.md` §2, §6) — these brick files already on users' disks.

Do not enable auto-merge without that exclusion list encoded somewhere
enforceable, not just written down here.

## 2026-07-24 — Upstream suite naming, vault and spaces/dash plans (stub)
The upstream project planned a family of apps (notes, dashboards, a personal
vault server, a relay) under one platform name. None of that ships in Tessera:
the relay, spaces and vault code were removed (see "Upstream surface removed",
2026-10-22) and the naming rules for that family do not apply here. Tessera's
own naming is in the 2026-11-04 entry.

## 2026-07-24 — Hold marketing-surface i18n
Don't localize the upstream landing page or README yet: the landing page
will be rebuilt around the multi-app suite, so translations now would only
drift. App UI i18n (7 locales) is the localization that matters and already
ships. Revisit once the new landing page is stable.

## 2026-07-24 — No bot/AI-agent identities in git history
External PRs get provenance review before merge (`gh api users/<login>`);
scatter-bot/AI-agent contributions are declined. A bot's merged PR was
scrubbed from history via filter-repo + force-push, and `main` is now
branch-protected (1 required review, no force-pushes). Human contributors'
authorship is preserved normally.

## 2026-07-22 — v1.0.7 launch (Show HN) and post-launch fixes
Launched publicly (#1 on HN, ~1000 pts). Post-launch priorities were driven
by thread feedback: collab focus-steal fix, chart zero-baseline for negative
values, mobile-Safari pinch, reduce-motion mode — all shipped in v1.0.8
alongside panel UI for community format features (text gradient, text-stroke,
blur/blend, backdrop-filter). Community format features are accepted when
additive + composable (unknown fields preserved; effects compose).

## v1.0.7 — Morph identity decoupled from element id
Elements carry optional `morphId` overriding the morph pairing;
`data-flip-id = morphId || id`. `id` stays the stable identity (selection,
anchors, CRDT). Chosen over mutating ids, which would have broken comment
anchors and collab node identity. Details: CLAUDE.md (render.ts section).

## v0.9.x — Charts are in-house (ECharts removed)
ECharts was 630KB (~47% of the shell); replaced with charts-lite interpreting
the same option SHAPE (pure JSON, no functions). Exotic configs degrade
gracefully rather than crash. Don't re-add a chart dependency; extend
charts-lite instead. Details: CLAUDE.md (charts section).

## v0.9.x — Collab credentials mint-at-creation, dormant until shared
Decks are born collab-capable but never auto-connect unless the doc arrived
carrying collab or the user opted in — fresh templates/demos must never phone
home. Read-only and writer roles are enforced cryptographically at the blind
relay, not honour-system. Spec: docs/collab-design.md.

## v0.x — Releases are cut locally, never in CI
The signing key never leaves the maintainer's machine; the signed bytes are
the served bytes. CI may validate (typecheck/build/gates) but never signs,
publishes, or deploys. Runbook: docs/RELEASING.md.

## v0.x — Single-file architecture is the product
One HTML file = document + viewer + editor, working offline from file://.
The splice contract on `#tessera-doc` is frozen forever (shipped updaters
depend on it). Everything else is negotiable; this isn't. See
docs/PLATFORM.md §1–2.

## 2026-07-25 — Large assets travel out-of-band; the relay stays blind

Assets over 64KB (`BLOB_INLINE_MAX`) no longer ride inside CRDT ops. They are
encrypted client-side, uploaded once to the relay's R2 bucket, and referenced
from the document by a content-addressed key; peers fetch and decrypt on
receipt. This was forced by measurement, not preference: Durable Object storage
values cap at ~2MB, so the previous inline path produced frames the relay
accepted-then-dropped, and the client re-sent forever. Details and threat model
in `docs/blob-offload.md`.

Three properties are load-bearing and must not be traded away:

- **The relay cannot read a blob.** It pipes ciphertext without buffering. The
  key is `HMAC(roomKey, sha256(plaintext))`, so identical bytes dedupe *within*
  a room and are unlinkable *across* rooms — a plain content hash would have
  let the relay confirm two rooms hold the same file.
- **R2 is optional.** Absent binding = `/b/` answers 501, clients inline small
  assets and same-origin tabs still resolve from the local cache. A
  self-hoster without a bucket degrades; they are not broken. This follows
  from the relay being dumb infrastructure (see the stub for upstream plans).
- **Failures are visible, never silent-but-wrong.** An unresolved blob leaves
  the asset absent and renders empty rather than blank-looking-fine. The whole
  change set exists because the old failure mode was invisible.

Operational consequence: the relay must be deployed **before** a client that
depends on the blob endpoints — the standing rule for this split, same as the
keepalive and access-verification changes.

## 2026-07-25 — Solo review model: PR + green CI, zero required approvals

**Amends the entry below** ("Every PR gets human review before merging"). The
intent stands — every change lands via PR and the maintainer reads it — but the
*mechanism* was wrong and was quietly defeating the CI gate.

`main` required 1 approving review. GitHub forbids approving your own PR, so on
a one-person project that requirement is unsatisfiable and **every** merge had
to use `--admin`. Admin bypass skips *all* branch protection, including the
required `validate` status check. Net effect: the CI gate was decorative, and a
red build could land on `main` with nothing to stop it.

Now: `required_approving_review_count: 0`, PRs still required, `validate` still
a required status check, force-pushes and deletions still blocked. A normal
`gh pr merge` works and genuinely cannot merge a red build. Admin bypass stays
*available* (`enforce_admins: false`) but is now an exception rather than the
daily path — if you find yourself reaching for `--admin`, that is a signal
something is actually failing.

Human review is a practice, not a GitHub setting, for as long as the team is
one person. Restore a real approval count the moment a second reviewer exists;
the future-action exclusion list in the amended entry still applies.

## RTL is two separable problems; only one of them is the document's

**Decided:** 2026-07-26. Supersedes nothing; establishes the split.

Content bidi and chrome mirroring get confused constantly, and treating them
as one feature produces the wrong answer to both.

*Content* direction is a correctness bug and belongs to the document: an
Arabic sentence puts its full stop in the wrong place without `dir="auto"`,
and it is wrong for everyone who opens the file. Cheap, uncontroversial, do it.

*Chrome* mirroring is a UI convention. Nothing is incorrect without it; the
editor merely feels foreign to an RTL reader. It was deliberately sequenced
AFTER an RTL language pack existed, because mirroring a UI whose every label
is still English is worse than not mirroring — and because the point of
shipping a pack first is to learn whether RTL users actually turn up.

The invariant that falls out of the split — **the document never mirrors** —
is recorded in `PLATFORM.md` §8 and binds every app. A document that
looks different depending on the viewer's locale is a format-level bug.

Cost, measured rather than guessed: ~430 bytes in the shipped shell for the
whole chrome conversion, and **zero** for the languages themselves, because
every RTL language is a pack. Size was never the constraint here. The real
constraint is that 32 of the editor's ~36 direction-adjacent coordinate sites
live in `canvas.ts` (Moveable/Selecto), which cannot be verified by an agent —
synthetic drags on Moveable handles do not register at all. Pinning the
document surfaces LTR was sufficient to leave that math untouched, and that is
the outcome to preserve: if a future change makes chrome direction reach
`canvas.ts`, stop and reconsider rather than refactoring the coordinate code.

**No plural system.** Hebrew (and later Arabic) ship without one. Of 15
count-bearing strings only 6 take a real count; the rest are index labels
(`Axis {n}`, `slide {n}`) or abbreviated times. Six strings do not justify
changing the catalog format, the build script, the CI gate and every catalog.
Translators phrase them count-agnostically instead (`מחוברים: {n}`), which is
standard practice when a framework lacks plurals and costs nothing at runtime.
Revisit only if a language arrives where the workaround genuinely fails.

## Audience polls: one join code per talk, and question kinds the deck tallies

**Decided:** 2026-07-27. Extends the poll design (see the poll entry above); breaks nothing already shipped.

Four changes, one theme: the audience should scan once and the deck should do
the arithmetic.

**One QR per talk, not per slide.** `doc.poll.session` is a deck-wide code; the
presenting deck POSTs whichever question is on screen to `sessions/{code}` and
the audience's page polls it. Answers still go to each question's own `code`,
so summarize, clear and export are untouched by any of this — a session is a
*pointer*, and that is what makes the change additive rather than a migration.
Two properties are load-bearing:

- **Session codes carry an `s` prefix; question codes cannot.** `CODE_ALPHABET`
  has no `s` in it. So the join page decides "follow the speaker" vs "answer
  this one question" from the code alone, with no round trip — which matters
  precisely in the case that has no server answer to wait for: someone scanning
  the QR before the speaker has opened anything.
- **A fork re-mints the session** (template open, "Duplicate as new deck…"),
  exactly as it re-mints question codes. Two speakers running one template must
  not steer each other's room.

Publishing is best-effort and deduped: a talk's forty non-question slides send
one "nothing is being asked" and then nothing. A failed publish clears the dedupe
so the next slide change retries. Present mode publishes, the editor does not —
"follow the speaker" means follow *presenting*, and an author clicking around
their deck must not be able to yank a live room from question to question.

**Choice and rating are tallied in the deck, never by a model.** The wire format
stays ONE STRING for all three kinds: a choice sends the option's own text, a
rating sends the number as digits. That keeps the service ignorant of question
kinds, keeps every already-collected answer valid, and means editing a question's
options later cannot retroactively rewrite what somebody chose — a stale answer
lands in an `Other` bucket instead of vanishing from a count read aloud on stage.
Tallying lives in `model.ts` (`tallyChoices`, `ratingStats`) so the live slide,
the panel and the spreadsheet export cannot disagree.

Defaults differ by kind on purpose: open-text answers stay HIDDEN until asked for
(unmoderated words on a projector is a decision), aggregates are SHOWN from the
first response (a bar chart nobody can see is the question missing its point).

**Names are per question, off by default, and never summarized.** A name changes
what people are willing to say, so it is a deliberate per-question choice. The
audience page asks once per session and keeps the name on the phone. The summary
is written back into the deck file and travels with the file; raw answers do
not — so attribution belongs in the export the speaker chooses to make, not in a
document they may forward without rereading.

**A hand-rolled `.xlsx` writer** (`slides/src/xlsx.ts`, ~7KB) rather than CSV or
a library. CSV loses the sheet-per-question split and mangles commas and
newlines — which is most of what audience answers are made of — differently in
every locale Excel is configured for. SheetJS is larger than the whole shell.
An xlsx is an OPC package, an OPC package is a ZIP, and a ZIP with every entry
STORED needs a CRC32 and correct offsets and nothing else. The risk in
hand-rolling a container is a file that downloads fine and refuses to open on
someone else's machine after the talk, so `scripts/test-xlsx.ts` validates the
output with a reader that is not ours (python's `zipfile` + an XML parse of
every part). The writer is deliberately spreadsheet-shaped, not poll-shaped:
it is a general-purpose writer.

## The lecturer key protects the ANSWERS, not just the controls (v1.0.13)

`LECTURER_PASSWORD` used to gate four presenter routes and nothing else, on the
stated principle that it "protects the controls, not the contents". That
principle was wrong for one payload, and named quizzes are what exposed it.

**Every participant holds the question code.** The QR prints the deck's session
code, but `GET /api/session` hands each phone the `code` of whatever question is
currently open — it has to, or the join page cannot follow the speaker. So any
participant with a network tab could `curl /api/poll?c=CODE` and read every
response verbatim. With `requireName` on, that is a roster of who answered what.
For an anonymous opinion poll that is the documented trade-off. For a graded
quiz with names it is a straightforward disclosure of student data, and no
amount of "the code is the invitation" reasoning covers it.

So `answers[]` is now gated. Three things made that safe to do:

**A SOFT check, not a 401.** `hasLecturer` writes nothing and returns a bool, so
`GET /api/poll` varies its *payload* by caller instead of refusing. The join
page and the presenting deck call the same route and only one of them may see
the responses; a 401 there would break the room in order to protect it. The join
page still gets its question, an activity page still gets its HTML.

**`count` stays public.** Participation is not a disclosure — "42 answers so
far" tells you nothing about what anyone said, and the phones and the join page
show it. This is the line: the *number* is public, the *text* is not.

**`answersWithheld: true` rides along.** An empty array is ambiguous in the one
way that matters on stage: "nobody answered" and "you may not read this" look
identical, and a presenter who believes the first when the second is true tells
a room nobody responded. Every surface branches on the flag — the live slide
draws the question's options and says the responses are locked rather than a bar
chart of zeros; `exportPollsXlsx` returns `withheld[]` and the panel raises an
`alert`, because a spreadsheet that is empty for want of a key is exactly the
failure the export exists to prevent.

The cost is that a **reporting embed must send the header itself** (from
`window.TESSERA_EMBED.poll.lecturer`, which was already injected for this). An
embed that ignores this charts an empty bucket, so `docs/guide/reference/agents.md` carries the
fetch recipe including the `answersWithheld` branch.

**What this still is not.** One shared password per deployment, not an identity.
Anyone handed the template can read your students' answers with it. Real
per-lecturer isolation needs a separate deployment, and saying so is more honest
than pretending a longer password would fix it.

## The lecturer key is entered BEFORE the talk, not discovered during it

The key had exactly one entry point: a `window.prompt` fired on a 401. That is
the wrong moment, and for the most important route it never came at all.

`POST /api/session` — the route that points the room's phones at the current
question — runs on **every slide change**. It therefore must never prompt (a
dialog per slide is unusable), which meant a presenter with no key got a talk
where the audience's pages silently never followed along, with nothing on screen
to say why. The server's own 401 text had been saying "enter it in the deck
(poll panel)" for the whole time there was no such field.

Now there is one (`buildPollLecturerKey`), backed by a new `GET /api/lecturer` →
`{required, ok}` so the panel reports the truth — "this service requires a key",
"the one saved here is wrong", "accepted" — instead of guessing from silence.
`present.ts` also runs `ensureLecturerKey` once at the top of a show, gated on
the deck actually containing a poll, never awaited (it must not cost the
fullscreen gesture its user activation) and never fatal: an unreachable service
answers "don't know" and the show goes on.

**On the oracle `/api/lecturer` creates**: it confirms a guess without a side
effect. That is not new — `POST /api/session` was always exactly that oracle and
cheaper to script than the destructive or billable routes. The route adds
convenience, not capability. The mitigation was always the password itself, so
the docs now say plainly: long, random, rotated between cohorts.

## The legacy service's database rules were a FILE, not a code block in a README (legacy service, no longer shipped)

The live rules on the poll project silently kept Google's test-mode default,
which expired and returned `PERMISSION_DENIED` on every route — including the
audience join page. The whole service was down and the repo showed nothing,
because the rules existed here only as prose in its README.

Prose does not deploy and nobody reviews it. The rules file plus `firebase.json` make the rules diffable and deployable in one command;
`RULES.md` explains why they are deliberately open on four paths (the service
authenticates to its database with the web apiKey, so no rule can distinguish it
from anyone else — access control lives at the API layer instead) and what to do
if that apiKey leaks. Deploying the app did not deploy rules; they are a
separate resource with a separate lifecycle, which is precisely how the two
drifted apart unnoticed.

## Embed figures step on arrow keys, then hand the show on (2026-09-10)

A click into an `embed` gave its frame the keyboard, and the deck never saw an
arrow again until the presenter clicked outside — "click out before moving on"
was written into every figure's speaker notes. Fixed with a postMessage bridge
rather than by stealing focus back: the page reports keys it did not use, and
the deck offers its own keys to a stepped figure first. That gives PowerPoint's
animation model — → builds the figure, the → after the last build is the next
slide — and works from a clicker without anyone touching the frame.

The offer is **opt-in** (`window.TESSERA_STEPPED = true`): every figure written
before this wraps from its last step to its first on →, and routing keys to it
would trap the show. Old figures keep their old behaviour; rebuilt ones get the
new one. Messages carry no capability — at worst a page moves the show a slide.

## Lists render from "• " lines; morph is the default transition (2026-09-10)

**Lists.** A bullet slide used to be a text box per bullet plus a box per dot.
It could not be edited as a list, and the compiler's glyph estimate decided
where each next box started, so any line that wrapped differently from the
estimate left uneven gaps. A text element now draws its own `- ` / `• ` / `– `
lines as list items (`layoutListLines`, render.ts): accent marker, hanging
indent, 0.4em apart, a second level for two leading spaces. The stored `html`
stays plain so the editor's existing "- " autoformat and paste conversion keep
working unchanged, and editing restores the raw text first. Only left-aligned
text is transformed — a centred "– Name" attribution is not a list.

**Morph by default.** `emptySlide`, the built-in layouts, the sync healer, the
template and the compiler all default to `morph`. With page furniture
sharing ids on every layout, morph is the transition that makes the chrome sit
still; between slides with nothing in common it degrades to "new content rises
in", which reads better than a full-slide fade.

## ⌘S goes back to the opened file: a remembered handle, proven by name + mtime (2026-09-21)

A `file://` page cannot reach its own file, so a double-clicked deck saved
through a picker every session, and Chrome truncates the picked file on
confirm — the long-standing "blank save, then the real one". Options weighed:
(a) ask people to open decks through a file picker or drag-and-drop instead of
double-clicking — a habit change nobody would keep; (b) match the remembered
handle by docId alone — unsafe, docId survives copying and `v2` → `v3` copies
are how decks are versioned here; (c) remember the handle in IndexedDB and
adopt it only when `handle.name` equals the URL basename AND the handle's
`getFile().lastModified` equals `document.lastModified`, which Chrome sets from
the file's mtime on `file://` (verified in headless Chromium). Chose (c). A
mismatch — a copy, or a deck a build script rewrote since the tab loaded —
falls back to the picker, now pre-filled with the open file's name and folder.
Serialization also starts while the dialog is open rather than after, so even
a first save no longer leaves the file empty. Details: `kernel/src/save.ts`,
FORK gotcha 11.

## Safe external links in rich text (2026-09-24)

Text anchors retain only absolute HTTP(S) destinations, with a forced new tab
and noopener/noreferrer. Other attributes are stripped, including on nested
markup inside unrecognized tags. Underlines make links visible in slides and
exports. Anchor clicks take precedence over containing slide-navigation links.
Existing two-space second-level bullets and inline code require no model change.

## Local agent edits enter the editor store (2026-09-24)

Use an optional authenticated localhost bridge and ID-addressed compare-and-set
transactions. File watching and whole-document replacement cannot preserve an
owner's unsaved edits. The receiving editor owns persistence and forwards accepted
changes through existing SyncSession; no relay protocol change. Port 18765 avoids
the existing Vite listener on 5174. Pairing tokens are local, never in the document.

Undo now applies a conditional inverse rather than restoring the entire snapshot;
unrelated later edits survive, conflicting reversals fail visibly. Async saves
compare captured content with current content before clearing dirty. During live
work the browser document supersedes Markdown until explicit reconciliation;
compiler/disk-tool guard files prevent accidental overwrite. See `agent-live.md`.

## Template pictures are voxel illustrations (2026-09-28)

The maintainer chose the isometric low-poly voxel style of a lab deck
as the house picture style. The template's three sample photographs (`img-coding`,
`img-audience`, `img-dashboard`) were regenerated in it, so a deck made from the
template starts in the right look; `/slide-image` now generates in that style by
default. Sources and prompts: `template/media/CREDITS.md`.

## Tables get row rules, a header rule, capitals and chips (2026-09-28)

The table element could only box every cell, so the quiet editorial table
The maintainer wanted (hairlines between rows, a blue rule under a small-caps header,
Demo/Lab tags, command chips) was impossible without faking it with shapes.
Added three optional `TableStyle` fields (`rules`, `headerRule`, `headerCaps`)
and a **Rows** panel preset, and let cells carry `<code>` / `<mark>` chips,
styled inline by the renderer in the theme accent so print and thumbnails match.
`MARK` joined the sanitizer's tag list; it still carries no attributes.
Older shells ignore the fields and show a normal grid, so no document breaks.
The template's theme table and slide 15 use the Rows look.

## Code blocks are code-only lines in a text box (2026-09-28)

The maintainer wanted a code sample as a sub-point on a bullet slide. Rather than a new
element or block markup (the stored html has no list DOM and the sanitizer keeps
no attributes), a line holding nothing but one `<code>` span renders as a block:
monospace 0.7em, tinted box, 3px accent edge, indented to its list level
(leading spaces = level 2). Consecutive code lines join into one block, so a
multi-line snippet is several lines. Typing `` `x` `` already makes the span and
pasting a ``` fence produces the lines, so no new UI was needed. Centred and
right-aligned text is left alone, as for lists.

## Agents connect without a pasted token (2026-09-28)

The maintainer wanted live editing without clicking Connect agents. An open `file://`
deck now claims its per-file token from the bridge (`POST /claim`, origin
`null`, the file must exist and be a Tessera document), probing every 2-5 s until
a bridge runs. The paste step protected nothing worth it: the token only lets a
page play that deck's editor, and the editor alone writes the file. The button
now toggles agents off/on per file. The live-source guard is written on the
first agent patch instead of on connect, since every open deck now connects.
`slide.py DECK.html` routes to that deck's open editor, so live is the default.

## The template's hive slides show sample answers until a question is set (2026-10-04)

The maintainer found the template's two open-question slides a poor showcase: with
`liveInEditor` they run the real page, which reads a fresh bucket and says
"0 answers". Swapping in frozen pages was rejected because `slide.py copy`,
`add-poll` and the compiler all take `page-hive-cluster` / `page-hive-matrix`
from the template, so every new deck would inherit frozen sample answers. Instead
the pages carry the sample themselves (`const SAMPLE=`, baked by
`make_figures.py`) and use it only while the poll's question is still the
placeholder "Your open question" (the matrix also requires the template's own
axes). No tool strips anything; writing a question is what turns a slide live.
The hive's sample clustering is the poll service's own algorithm run locally,
never hand-grouped. Details: `template/README.md`, "Sample mode".

The same pass made the template's figure embeds `liveInEditor: true`, replaced
the hype-cycle example with two figures (`s19-embed` roadmap, `s20-embed`
Hugging Face incident), dropped the centred-statement, extra divider and 2×2
matrix *slides* (their layouts stay, the compiler uses them), and gave
`compare` a blue right-half panel (`cm-panel`) in place of the hairline.

## Sharing is off until someone goes live (2026-10-05)

The maintainer sent a deck to a colleague and found a "Guest" in the editor: upstream
mints collaboration credentials live (`on: true`) and treats saving as the
opt-in, so every saved deck, and every copy of it, joins one room on
the upstream relay on open and edits flow both ways (the copy even carries
`ownerPriv`). They had not known a server was involved. `mintCollab` now mints
`on: false`; only "Go live" in the Share panel (and the share actions that call
it) connects a deck. Saving still reconnects a deck that is already live.
Existing decks keep their keys with `on` set to false, in every deck on disk, so an old shell stays off too (its save path only joins when
`on` is not false). A copy for someone else is "Duplicate as new deck…" or a
present-only export, never the working file.

## A duplicated slide gets its own figure page (2026-10-05)

The maintainer duplicated a figure slide with the sidebar button, had the copy's figure
revised, and the original changed too. The elements were independent (deep
clone, per-slide CRDT keys); the link was `doc.assets`: both embeds pointed at
one `page-NAME` key, and a figure is revised by rewriting that key. Slide
duplicate and same-deck slide paste now call `forkFigureAssets`, which copies
an embed's/svg's page and an embed's poster to `<key>-2`; `slide.py dup` does
the same. Costs one extra page per duplicate (tens of KB) until the copy
diverges. Images are deliberately NOT forked: the logo is one asset on every
slide, and replacing a picture in the editor already interns a new key. A state
slide and a slide made from a layout keep the shared page (same view; template
figure). Not retroactive — slides duplicated by an older shell stay on one key.

## "Duplicate as new deck…" saves the copy before becoming it (2026-10-05)

The maintainer duplicated `slide1.html` into `slide2.html` and found the two still
connected. `saveAsNewDeck` swapped the new document into the editor FIRST and
then opened Save As, so for as long as the picker was up (and for good if it
was cancelled) the new deck sat in memory with the original file still the
⌘S/autosave target — the 2.5 s autosave wrote the copy over the original. And
the swap was an undo step: one ⌘Z too many restored the original's `docId`,
collab keys and poll codes into the copy's file. Either way two files ended up
with one identity, which is what links them (same BroadcastChannel between
tabs, same live room, same recovery slot, same answer buckets).

Now the clone is written to its picked file first; only a successful save-as
swaps it in, and the undo history is cleared at the fork (`Store.clearHistory`).
Cancel leaves everything untouched; a download fallback leaves the editor on
the original and the copy in Downloads. The agent bridge also stops re-claiming
its URL once the tab has been saved under another name — it used to drop the
token and claim it straight back, so an agent editing the original file was
handed the copy. "Save a copy…" is unchanged and still deliberately the SAME
deck (same docId, same session).

## A figure's page is always in the file; `devSrc` is only a view (2026-10-10)

Copied infographic slides kept arriving blank. In-app duplicate and paste were
already correct (the page asset travels and is forked). The hole was the live
workflow: the authoring tools pointed the embed at `http://127.0.0.1:5173/build/figures/x.html`
and DELETED its asset, so until someone remembered to bundle it the slide was a
pointer to a file on one machine, relative to whichever deck folder the server
happened to be serving. Copy it to another deck, publish it, or stop the server
and it was gone.

Now the address is a separate field, `devSrc`, honoured only on the edit canvas
of an editable deck, and the editor itself keeps `asset` equal to the source
(`dev-figures.ts`, a 2 s poll of the server's `/__live` signature). Rejected:
baking at save time (a fetch before the picker spends the user activation that
gotcha 9 protects) and making the renderer prefer `src` when the server answers
(reachability is async, and a show must never depend on it).

## Deck identity is shown, and a copy can be made independent in place (2026-10-10)

A course session went through v2…v5 as files copied in Explorer,
all one `docId`, and they synced into each other; v5 was separated by editing
JSON. The id was invisible and "Duplicate as new deck…" only helps before the
copy exists. Document properties now shows it, "Make this file independent"
re-ids the open file (new dormant collab, undo cleared, same file handle), and a
banner appears when two files with one id are open. Poll codes are kept by
default: a new version of a deck usually teaches the same room. The old id's
recovery slot is left alone, because it belongs to the other file. Pasting an id
is allowed (re-linking on purpose) and drops `collab`, whose keys are unknown.
"Never regenerate a docId" stands for tools acting on their own; this is the
author's explicit action.

## Join codes can be names (2026-10-10)

A class-specific code was set by editing JSON and had to start with
`s`. The prefix existed so the join page could tell a session from a question
with no round trip. Kept for minted codes; a chosen name is instead registered
with the service (`claim` on `POST /api/session`, `exists` on GET). Only a short
hyphen-less name costs the join page one extra request. Rejected: an owner per
session (there is one lecturer key; an owner check would lock a deck out of its
own name after a copy).

## The editor is AI-native (2026-10-22)

The maintainer: the agent generates everything; the person edits or deletes text and
asks for changes from the slide. So the chrome went (logo, insert tools, Share,
properties panel) and nothing calls the upstream site. Requests are review threads
flagged `request: true`, not a new document field: they already save with the
file, sync between tabs and pass the agent-patch whitelist (`slides`). Figure
text overrides live on the element (`texts`), not in the page, so a rebuilt
figure keeps the person's wording. Rejected: a separate chat server per deck
(the `chat-with-agent-box` pattern) — the editor runs from `file://`, the bridge
already has per-file auth, and a request must also reach an agent that opens the
file later. Anyone's agent must be able to serve the deck, so the contract is
the document shape plus the documented bridge routes, never one tool.

## Upstream surface removed (2026-10-22)

Follow-up to the AI-native editor: what was hidden is now deleted, so no code
path can reach the upstream site or a relay. Gone: the properties panel (`panels.ts`;
group/ungroup live in `editor.ts`) and insert tools; Share and the live relay
(`sync/online.ts`, `sync/blobs.ts`, `server/sync-worker`); the About dialog
(Document properties, Template file, Deck identity, Offline mode, update check,
licenses); self-update (`kernel/src/update.ts`, the manifest, signing and
release scripts: `keygen`, `sign-*`, `release.mjs`, `publish-site.mjs`); remote
and signed language packs (bundled catalogs and packs already embedded in a
file still work; `test-packs.ts`); PDF export; the help overlay and the `?`/`C`
shortcuts; the password UI (encrypted files still open and save encrypted);
"Copy/Replace document JSON" (`window.tessera.loadDoc` stays); `spaces/`,
`site-src/`, `ios/`, the guestbook scripts and `server/guestbook-daemon`; the
upstream starter deck (a minimal starter instead). Kept: the CRDT, which still
merges tabs and files with one `docId` over BroadcastChannel in one browser
profile. "Make this file independent" and version history moved to the
Save a copy menu; the lecturer key is asked by prompt when presenting or
exporting; `template: true` is set in the JSON. Why: every one of these was
either unused here or a way for a deck to talk to a server nobody chose.
Supersedes: "Sharing is off until someone goes live" (2026-10-05), "Deck
identity is shown, and a copy can be made independent in place" (2026-10-10,
the About panel half), "v0.9.x — Collab credentials mint-at-creation, dormant
until shared", "2026-07-25 — Large assets travel out-of-band; the relay stays
blind", "2026-07-24 — Upstream suite naming plans (stub)",
"v0.x — Releases are cut locally, never in CI", the fetching and signing
halves of the language-pack entries of 2026-07-25/26 (embedded pack blocks
still load) ("i18n: a bundled core of 9 languages, everything else a signed
pack", "A language pack lives in the FILE and nowhere else", "The pack carrier
is generic; pack POLICY is not", "Side-loaded artifacts: sign the index, pin
the bytes, fail closed", "Language packs are published under a SIGNED INDEX"),
and the panel field of "The lecturer key is entered BEFORE the talk".

## The editor has a phone view: read and ask, no editing (2026-10-22)

The maintainer: "Optimize also for mobile when I'm editing. I probably just need to see
the slides … and also the box for suggestions. No need to allow editing the
slide text there directly." So a phone gets a vertical scroll of every slide
and the ask box docked at the bottom, bound to the slide most in view; nothing
on it edits a slide (`editor/phone.ts`, OVERVIEW.md). The one `AgentPanel` is
moved into the dock rather than a second box written, so a request from the
phone is the same `slides[i].comments` entry by the same code. Rejected: a box
under every slide (N textareas, and the keyboard covers the lower ones); the
desktop canvas squeezed to phone width (handles and double-click editing are
what he said he does not need); running every figure in the scroll (only the
cards on screen run). Detection is a media query, live, with `?view=` to force
it, not user-agent sniffing.

## Undo history holds patches, not document copies (2026-10-22)

An audit found the tab dying of its own undo stack: every step kept two full
JSON copies of the document, so a 14 MB deck grew the heap ~55 MB per edit and
crashed at edit 73 (~3.9 GB). A step now holds only the conditional,
ID-addressed patches that take the document back across it (`diff(after,
before)` from `agent-patch.ts`, which undo already computed at undo time), so
semantics are unchanged: same conflict refusals, remote edits survive, same
slide and selection restore. The open gesture keeps one baseline, a
string-sharing JSON-equivalent copy (object skeleton only), diffed once per
`touch()`; no `JSON.stringify` of the deck on edit any more (55 ms -> 1 ms per
figure-text edit on that deck). Safety net: 64 MB estimated across both stacks,
oldest steps dropped first, the newest step always kept. Rejected: storing
forward patches too (undo never needs them; redo gets its own inverse from
the undo), and snapshot strings diffed lazily at seal time (still a full
serialize per edit).

## A save names the file version it is based on; the bridge refuses a stale one (2026-10-22)

An audit reproduced a lost write: the bridge's `/save` overwrote the deck file
unconditionally, so a `slide.py` write made while the tab was not counted live
(agents switched off, a throttled background tab) was wiped by the tab's next
autosave; a file with no `docId` (recompiles strip it) accepted any save. Now
every save from a current shell carries `base`, the SHA-256 of the block it was
built on (the tab hashes the block it booted from; the bridge returns the new
token with each save). A mismatch is a 409 with the file's block; the editor
replays the file's changes since its base as compare-and-set patches
(`save-merge.ts` over `agent-patch.ts`): untouched fields take the file's value,
a field both changed keeps the tab's value and is named in a toast, then the
union is saved. Rejected: mtime+size tokens (the tab cannot know the size it
loaded, and second-precision mtimes miss fast rewrites); refusing without
merging (the tab could then never save until reloaded, losing its own edits);
the file winning conflicts (the person's typing in front of them would vanish).
Old shells keep the unchecked JSON `/save`, by the PLATFORM rule that the bridge
serves every shipped shell; they are protected once re-hosted.

Same change, for speed (14 MB deck, 520-900 ms main thread per edit): the shell
is serialized once with sentinels and each save is pieces around one escaped
JSON (byte-identical to the old outerHTML path), the autosave stringifies once
and shares it (recovery, version, file, fold base), a revision counter replaces
`fileContentKey`, and the HTML goes to the bridge as the raw body (no 15 MB
JSON wrap); the bridge skips identical writes and does file work outside its
global lock. Also: `/wait` reports each request id once per listener (a
re-armed listener no longer fires at once on the request being served), and a
command to a deck open in several tabs with one `docId` goes to one of them
instead of being refused as ambiguous. `start()` replaces a running bridge
older than `VERSION`, since the bridge outlives every edit to its source.

## The editor's chrome: an ask bar under the slide, Requests | Notes on the right, a calmer top bar (2026-10-22)

The maintainer: "I am not convinced … that the agent in the right pane is the best
design, especially with the text box at the bottom. I am also not very
convinced of the speaker notes … nor of the buttons/options on top." A design
critique (subagent, screenshots at 1280-1920 and on a phone) found: the
request box sat in the far corner, ~600 px from the slide and from its own
thread; a request never showed which element it targeted; Done replies faded
to 65 %; agent status appeared twice in two vocabularies, and the top-bar one
was a toggle that looked like a label; the notes strip showed 2-3 cut lines of
~110 characters of prose the agent writes and he mostly reads; Slideshow was a
bottom-corner pill with a runner animation; the dirty dot sat in the window's
corner (`.ed-dirty` absolute on an unpositioned Save).

Now: the **ask bar** sits under the slide, slide-wide, one line growing to six,
with a chip "Slide 4 · “Title text”" naming the selected element (× drops it);
the **right column** has two tabs, **Requests** (status dot and word, relative
time, target chip, replies at full contrast, older Done folded, a line that
jumps to open requests on other slides) and **Notes** (prose at 14.5/1.6 in a
45-60 character column, word count and spoken minutes); `]` folds it to a
rail. The **top bar** is title + save state in words (a click saves), one
**agent pill** (No agent / Agent connected / Agent ready / Working on slide n
/ Agent paused; its menu pauses), **Present ▾** as the primary button (in this
tab, speaker view, join code) and **⋯** for every file operation (Save now,
copies, version history, frozen export, answers). Thumbnails: hollow dot =
requests waiting, pulsing = working, none when done. The phone dock borrows
the same RequestList and AskBar. `agent-bridge.ts` reports status as an event
and no longer owns a button. Rejected: notes as a collapsed drawer under the
slide (a one-line preview of 700-2,000 characters is still unreadable, and it
costs the slide height); keeping Save as a button (autosave already writes the
file; the state in words says when it cannot); the join code in the top bar (set
once per deck, needed only when presenting).

## Save and Save a copy are the only save commands; a copy is always its own deck (2026-10-22)

The maintainer: "check what save now, save a copy, duplicate as new deck, make this
file independent all mean. There's probably a lot of overlap and we just need
to have save and save a copy." They were: **Save now** = ⌘S, which with no file
handle (every deck opened from disk and written by the bridge) opened a Save As
picker and moved the tab to the picked file; **Save a copy…** = Save As keeping
the `docId`, so the two files went on editing each other (a course's
v2…v5); **Duplicate as new deck…** = Save As with a new `docId` and reminted
poll codes and session; **Make this file independent…** = a new `docId` for the
open file in place, the repair for a same-id copy.

Now ⋯ holds **Save** (with no handle and a working bridge it runs the autosave
at once; otherwise as before) and **Save a copy…** (always a new `docId`; a deck
with questions asks once: "Same room — keep the answers and the join code" or
"Another room — empty questions, new join code"). "Make this file independent"
stays only on the banner `identity-watch.ts` raises when two files with one id
are open, which is the only time it is needed; `slide.py fork` does it on disk.
Supersedes the last sentence of "Duplicate as new deck… saves the copy before
becoming it" (2026-10-05: Save a copy… "deliberately the SAME deck") and the
menu half of "Deck identity is shown, and a copy can be made independent in
place" (2026-10-10). Rejected: keeping a same-id copy as a "backup" (version
history is the backup, and a same-id file is a trap); a confirm() for the poll
choice (OK/Cancel cannot name two outcomes and cancel).

## No agent status in the top bar; the slide being edited is marked instead; Save is the save state (2026-10-22)

The maintainer: "agent connected also maybe is useless … What might be more useful is
an indicator in a specific slide if it's being edited", and the save indicator
"is a bit weirdly placed to the left … bundle it also with the save button?"
The pill only reported whether the local bridge answered, which says nothing
about whether anything is happening. Now an agent patch that changes a slide's
content (not a request's status or reply) marks that slide for 5 s: a green
ring on its thumbnail and a chip on the canvas naming the agent. Whether a
listener is there matters only for a waiting request, so the card says "no
agent listening". The pause switch, rarely needed, is ⋯ → Pause agent edits.
The save state moved to the right, before Present, and is the Save button
(click or ⌘S); Save left ⋯. Rejected: the save state beside the title (the
Google Docs place, but here it read as detached from every other control); a
split [Saved | Save a copy ▾] (brings back the split buttons he disliked).

## The right column folds with the slide list's chevron (2026-10-22)

The maintainer: "use the same button as left pane to minimize/expand the right pane."
The 46 px icon rail and the › in the tab row are gone; a strip between slide
and column carries the same `.ed-panel-toggle` as the slide list, and the
column folds to width 0 (`]` still toggles). A request sent while it is folded
leaves it folded: the thumbnail's dot shows it waiting.

## The game layer's client: an opt-in SDK, slide messages to every embed (2026-10-22)

The maintainer approved a game layer for the poll service (`docs/game.md`): games stop
rebuilding identity, dedup and state broadcast on answer buckets. The client
half: `slides/src/game-sdk.js` (`TesseraGame`) is injected into an embed's srcdoc
only when the page carries `<meta name="tessera-game">`, so the ~20 kB costs no
other figure anything and no shipped page changes behaviour. One file serves
deck screens and phones; the role comes from `TESSERA_EMBED` / `TESSERA_ACTIVITY`.
With no service it runs against `TesseraGame.mock()`, an in-memory copy of the
server's rules, so a game can be built, rehearsed and postered offline, and
`g.fake(name)` stands in for phones. The deck posts `{tessera:'slide', on}` to
every embed frame (not only game pages: any figure may want to start on
entry) and takes `{tessera:'goto'}` only from a frame on the current slide in
present mode, so a figure can never move a show it is not on. The live shim
learned `/api/game` (phones on the `ch=state` channel so moves do not wake 60
phones) and now invalidates a code's topics both when a write is sent and when
it lands: a timer read between the two used to cache the pre-write reply,
which a phone's own move would never correct. Rejected: a separate `<script
src>` from the service (a deck must work offline and a srcdoc page has no
reliable base URL); injecting the SDK into every embed (cost and risk for
pages that never asked); `on: false` delivery on exit (the frames are torn
down in the same task; `pagehide` is the page's last word).

## Asking lives in the slide list; a new slide is a request; deck-wide asks are `doc.requests`; the recovery banner is gone (2026-10-28)

The maintainer: "What's the best way in the UI to request new slides or have general
changes to the slide (e.g. asking to improve the flow of the presentation)?
… When you insert a slide, do not show any templates but just have a space to
indicate what you want added. Put the feedback field … at the left right next
to the slide preview … Remove the requests tab and instead just show the
progress also here to the left. Maybe indicator balls would be enough with
some small comment in the end what happened." Also: a save icon with ▾ beside
Save holding the ⋯ items, "remove" the notice of unsaved changes, and shift /
grid selection to move slides quickly.

Three kinds of ask, one thread shape (`{id, request: true, status, author,
text, at, replies, resolved?}`):

- **A change to one slide**: the open slide's row in the slide list unfolds
  under its thumbnail into its requests, one line each (a ball: hollow
  waiting, pulsing working, green done; a done one ends with the agent's
  reply in small type), and the field "Ask for a change to this slide…".
  Other thumbnails carry only the balls (the newest five). Stored as before
  in `slides[i].comments`. The right column is Notes only; the Requests tab
  and the ask bar under the slide are gone.
- **A new slide**: ＋ between thumbnails and "New slide" insert an empty slide
  there at once (one undo step, no layout picker) and the canvas shows a box
  "What should this slide be?"; what is typed becomes a request on that new
  slide's id, so the agent fills a slide that already sits in the right place.
  The box is editor chrome, not a slide element: an unfilled slide carries no
  text the agent must remember to delete. Custom layouts in `doc.layouts`
  stay (agents and `slide.py new --layout` use them); the person no longer
  picks one.
- **The whole deck** ("improve the flow"): a "Whole deck" field at the top
  of the slide list writes to a new top-level `doc.requests` array of the
  same threads, with no slide. `slide.py requests` prints them as `[deck]`,
  `reply` finds them, `ask --deck` records one; `listRequests` reports them
  with `slideId: ""`, `slideIndex: -1`, so `/tick` counts them and
  `window.tessera.requests.reply` serves them; `agent-editor.ts` accepts
  `requests` as a patch root. Older shells keep the field untouched (unknown
  fields are preserved) but cannot show it. Tab-to-tab sync carries
  `doc.requests` as one last-writer-wins register, so two tabs adding a deck
  request in the same instant can drop one; rare enough not to touch the CRDT.

Rejected: a deck-wide request parked on slide 1 (it would move and die with
that slide, and every reader would take it for a slide-1 request); a
placeholder text element on the new slide (it ships in the deck if unfilled);
an ask field beside every thumbnail (the list becomes a form; the open slide
is where one asks, and a click opens any other).

**Save** shows a cloud icon and the state (Saved / Saving… / Not saved to
the file), and a ▾ attached to it holds every former ⋯ item (Save a copy…,
Version history…, Export a frozen copy…, the answers, Pause agent edits).
Supersedes the 2026-10-22 rejection of a Save split button: he asked for it.

**The unsaved-changes notice** is the recovery banner ("Unsaved changes from
… were found. Restore / Discard"). It is removed. It came up whenever the tab
closed before its last save landed, and since agents write the file through
`slide.py` it mostly offered to restore an OLDER state over the agents' newer
file. Nothing is lost: a recovery snapshot that differs from the opened file is
filed into Version history (⋯ ▾ → Version history…) and the slot cleared. The
browser's leave-page prompt now fires only when the file is known to be behind
and no browser copy exists (a failed save with no IndexedDB); otherwise
leaving flushes the save at once, as switching tabs already did.

**Slide list selection**: click selects one, Shift-click a range,
Ctrl/⌘-click toggles; dragging any selected thumbnail moves the whole
selection (each parent with its interactive states) before or after the
drop target, as one undo step. Dragging the list's edge past 380 px lays
thumbnails out as a grid (the sorter view: balls only, no thread) where the
same drag reorders; the list can now be widened to 70 % of the window.

## The slide list is a review list: a comment field beside every slide; orbs are the only status; maximize for the grid (2026-10-28, later the same day)

The maintainer, after the first version above, prototyped the layout
(a standalone design prototype, not shipped): "To be more
efficient, I think I should just be able to easily comment across slides.
Let's follow this then." Then: "no need for see changes, also no need for the
check mark as it's redundant. Even 'Done' or 'in progress' is not needed, some
indicator orbs in the slide should be enough." And on wide lists: "A user
might prefer to have big thumbnails and so they might widen it but not really
want to reorder … allow full maximize of this, hiding the current slide. Only
here does it become the grid."

Now:

- **Left, the review list** (header SLIDE | WHAT SHOULD CHANGE? · Enter sends ·
  Shift+Enter new line): a "Whole deck" row first (a dashed card, its threads
  are `doc.requests`), then one row per slide: number, thumbnail, and a field
  that is always there ("Add a comment…"; "What should this slide be?" on an
  empty slide). The open slide's row is highlighted. **Enter sends and moves to
  the next slide and its field**, so a deck is reviewed without a click
  (`RowAsk`, `afterSent`). A comment aimed at the open slide's selected
  element says "About …" above the field.
- **Several requests on one slide**: the latest shows (its text, and the
  agent's one-line reply under it in small muted type: what happened); earlier
  ones fold behind "n earlier", which unfolds them all. The wire format is the
  one above, unchanged.
- **Status is only orbs** on the thumbnail (one per request, newest six:
  hollow waiting, pulsing blue working, green done; tooltip has text and
  reply). No "Working on it…", no "Done · see changes", no corner check. Kept,
  because the orbs are small and mostly off screen: the top bar's "{agent} is
  working on N requests" (neutral "Working on N requests" when no agent has
  signed anything; the name is the one on the latest agent edit or reply, the
  editor serves any agent) and the canvas chip "{agent} is updating this
  slide" while a request on the open slide is being worked on (and for 5 s
  after each agent edit, as before).
- **Right**: "Slide 3 of 5" with ‹ ›, the slide, and **speaker notes under the
  slide** (fold to their header with a click or `]`). The right column is gone.
- **Insert**: ＋ between rows and New slide insert an empty slide (no layout
  picker) and focus its row's field. The canvas box "What should this slide
  be?" remains only where the list has no fields (dragged narrow, or the
  grid).
- **Width**: dragging the list wider only grows the rows: the thumbnail grows
  with the column (150 to 360 px) and the field stays beside it. Below 330 px
  the list is thumbnails only. The list may take all but 360 px of the window;
  the width is remembered per viewer (`tessera-ed-review`; the old
  `tessera-ed-panels` width was the narrow thumbnail column and is ignored).
- **Maximize** (the icon at the end of the list's header): the list takes
  the whole area, the slide and notes are hidden, and it is the **grid**:
  thumbnails with orbs, no fields, Click / Shift-click / Ctrl-click to pick
  and drag to move (as in the list). The same icon or Esc restores the
  previous layout and width; double-clicking a thumbnail restores and opens
  that slide. No other key: `]` is the notes, `[` the list.

Supersedes, in the entry above: the ask field under the open slide's
thumbnail only, the whole-deck field above the list, the thread with balls in
the list, the 380 px auto-grid and the 70 % drag limit, the right notes
column. Rejected: "see changes" (he found it redundant; the orbs and the reply
say it); a toggle for the grid (he preferred maximize, which also explains
why the slide disappears); the prototype's sent text left editable in the
field (a sent request is a record the agent may already be acting on; a new
comment is a new request).

## 2026-10-28 — review list: status beside the comment, a draggable column, arrows between rows

The maintainer, while editing a deck: (1) the line between the thumbnails and
the comments is dragged to trade width between them (double-click resets to
the width that follows the list); (2) the Whole deck row has no thumbnail
card: a small label, and its comments take the whole row; (3) Up on a
field's first line and Down on its last move to the row above or below (the
whole deck sits above slide 1), opening that slide; (4) the reply under each
comment was ugly: a status dot now starts each request, the request turns
green when done, and hovering the dot shows the reply. The orbs leave the
thumbnails in the review list ("the green indicator is better there than
inside the thumbnail"); the narrow list and the grid keep them, having no
comments to put a dot on.

## 2026-11-17 — lab phone: two buttons; the screen counts only Finished

A lecturer, after running labs from the student side: the phone was too
wordy. Now (1) two buttons, **I need help** and **Finished**, in place of
Lost / Working on it / Finished; (2) the AI helper is hidden until I need help
is pressed, and the button pressed decides what shows under it (the helper,
or Share what you did; the helper's thread is kept while hidden); (3)
Finished shows only "Share what you did" with Camera and Upload, no
explanatory lines, and once a picture is chosen those two give way to the
picture, the description and Send; (4) the card shows one count, the phones
that say Finished, with no bar or other states; (5) no "three next steps" on
Finished (the phone no longer calls `/api/help` mode `next`; the service
keeps it). Compatibility: I need help stores `st: "lost"`, the value Lost
stored, so the answer format is unchanged; the card still reads `lost`,
`working` and `finished` and takes each phone's latest, and a phone whose
latest is not `finished` is just not counted. The privacy line stays in the
footer.
