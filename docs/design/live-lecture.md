# Live lecture co-pilot — design sketch

*Design document, 14 October 2026. Status: **idea, not implemented.** The presenter's
words: "have my phone recording my lecture while I'm giving it and then Claude
can check it every now and then, add, revise in real time." Nothing here has
been built or tested; every component name below is a proposal.
Companion: `live-feedback.md` — the same loop fed by student feedback
instead of the presenter's voice.*

## What it would do

While the presenter lectures, the presenter's phone records what the presenter says. Every minute or two a
Claude session reads what was said since the last check, compares it with the
deck, and changes the deck — and the changes appear in the open editor and on
the projector without a reload, because that is already how agent edits land
(`agent-live.md`, `tools/publish.py live`).

The useful edits, from safest to boldest:

1. **Speaker notes and a lecture log.** What the presenter actually said, attached to the
   slide the presenter was on. Afterwards: the raw material for revising the deck and a
   ready summary for students. Invisible to the room.
2. **A live board slide.** One dedicated slide ("What we said today",
   "Your questions") that Claude keeps rewriting: key points, a student's
   question and the answer the presenter gave, a term the presenter defined. The presenter flips to it when needed
   wants to recap.
3. **Voice commands.** "Claude, put that on a slide", "Claude, add that
   example to the next slide", "Claude, note the question about X for the
   end." An explicit trigger phrase means Claude never has to guess intent.
4. **Revising upcoming slides on its own.** A student raised a point the deck
   handles three slides later; Claude rewords that slide to pick up the
   thread. Highest value and highest risk — only behind an approval step.

## Architecture

```
 phone (browser page)          presenter computer                                  room
 ────────────────────          ─────────────────────                     ────
 mic → MediaRecorder  ──HTTPS──▶ lecture service ──▶ transcribe ──▶ transcript.jsonl
 20–30 s chunks                 (live mirror tunnel)   (STT)              │
 shows proposals  ◀───────────────────────────────── proposals.json ◀──┤
 [Approve][Skip]  ───────────────────────────────────▶                 ▼
                                                     Claude Code session
                                                     (wakes on new transcript)
                                                         │ slide.py … live
                                                         ▼
                                                     open tessera editor ──▶ live mirror
                                                                           the live mirror URL
                                                                           = what the projector shows
```

### 1. Capture — a page on the phone

A small web page behind a live-mirror tunnel (tools/live/serve.py) and Cloudflare Access (same
login as the live mirror), e.g. `<live-mirror-host>/lecture`. It uses
`getUserMedia` + `MediaRecorder` to cut the audio into 20–30 s chunks and POSTs
each one with a sequence number. Chunks queue locally and retry, so a dropped
classroom Wi-Fi connection delays the transcript instead of losing it.

Practical traps to design for:

- **The screen must stay on.** Mobile browsers stop recording when the phone
  locks. Use the Wake Lock API, and show a big "RECORDING · 34 min" banner so
  the presenter notices if it stops.
- **Audio quality decides everything.** A phone on the lectern hears the room;
  a cheap clip-on mic plugged into the phone hears the presenter. Start with the lapel mic.
- **Alternative:** the same page opened on the presenting laptop. Simpler (no
  phone at all), but the work Mac's browser and mic permissions are an unknown.

The same page doubles as the control surface: it shows Claude's pending
proposals with Approve / Skip buttons (the `chat-with-agent-box` pattern), so
the presenter can glance at the phone between slides instead of touching the laptop.

### 2. Transcription

Claude reads text, so audio goes through a speech-to-text step first (if the
Claude API accepts audio directly by the time this is built, skip it). Two
options:

| option | for | against |
|---|---|---|
| cloud STT API (Whisper-class, Deepgram, ElevenLabs Scribe…) | fast, accurate, no GPU needed | audio leaves the PC; per-minute cost; needs a key in `.env` |
| local `faster-whisper` on the PC | audio never leaves the PC | needs a decent GPU to keep up in real time — unverified on this machine |

Output: `slides/<deck>/build/lecture/<date>/transcript.jsonl`, one line per
chunk: `{seq, t_start, t_end, text}`. Audio files are deleted once transcribed
unless the presenter asks to keep them.

### 3. Knowing which slide is on screen

The transcript is only useful tied to a slide. Sources, in order of preference:

- the presenting page reports its current slide (the live mirror already syncs
  through `the editor agent hook`; it would need to send the slide id back),
- `agent_live.py read` → `currentSlideId` of the presenter-computer editor, if the presenter presents from
  the PC itself,
- inferred from the transcript against slide text — a fallback only.

Each transcript line gets a `slideId` stamp.

### 4. The Claude loop

A Claude Code session started in this repo before the lecture, with the deck
open in the editor and `tools/publish.py live` running. It uses the `Monitor` tool
on `transcript.jsonl` (no polling; it wakes when lines arrive) and batches to
roughly one decision every 60–120 s, or immediately when a trigger phrase is
heard.

Each wake-up it reads: the new transcript lines, the current slide and the next
three (`slide.py get … live`), the lecture log so far, and the deck's
`README.md`. It then does at most one of: append to the log / speaker notes,
rewrite the board slide, apply a voice command, or write a proposal.

Edits go through `slide.py … live` / `agent_live.py patch`, which are
compare-and-set: if the presenter touched the same slide, the patch is refused rather
than overwriting the presenter. Every patch carries its `before`, so each one can be undone.

A one-page prompt file for the session (`build/lecture/PROMPT.md`) states the
rules below, the deck's goal, and the trigger phrase.

## Rules the loop must follow

- **Never change the slide on screen or any slide already shown.** Only the
  board slide, speaker notes, and slides ahead of the current one.
- **Visible edits to upcoming slides are proposals** until the presenter approves them on
  the phone (mode 4). Notes, log and board slide may apply directly.
- **At most one visible change per wake-up**, and nothing that changes a
  slide's layout or figure — text only, in the deck's existing style.
- **No polls, no embeds, no new figures live.** Those go on the post-lecture list.
- **When unsure, log it, do not edit.**
- The live deck is authoritative until reconciled: if the deck has a `.md`
  spec, nothing is recompiled during the lecture, and the live-source guard is
  respected (`agent-live.md`).

## After the lecture

The session writes `build/lecture/<date>/summary.md`: what was covered per
slide, what was skipped, questions from the room, and a list of proposed deck
revisions. It then reconciles the live edits into the spec (if any) and the
deck's `README.md`, and commits. The summary is also the draft of a recap
announcement for students.

## Privacy and consent

Recording a classroom is recording students. Before any real use:

- record **only the lecturer's mic** (the lapel mic helps here too) and never
  attribute anything to a named student in the log or on a slide,
- tell the class at the start, and check the institution's rules on recording sessions
  (GDPR; there may be an existing policy for lecture capture),
- keep audio only as long as transcription takes; if a cloud STT is used,
  choose one that does not train on or retain the audio.

## Build order

1. **Offline rehearsal (no class involved).** Record one of the presenter's talks, then
   replay its transcript at real speed against a forked copy of a deck
   (`slide.py fork`). Tune the prompt, the cadence and the rules until the
   edits are ones the presenter would keep. This is where most of the work is.
2. **Notes + log only, in a real lecture.** Nothing visible changes; judge the
   transcript quality and the slide stamping afterwards.
3. **Board slide + voice commands.** The first visible features, both under
   the presenter's control.
4. **Proposals for upcoming slides**, approved from the phone.

## Pieces that already exist

| need | existing piece |
|---|---|
| edit the open deck without reload, compare-and-set | `slide.py … live`, `agent_live.py` (`agent-live.md`) |
| projector view that follows edits in place | `tools/publish.py live` → the live mirror URL |
| an authenticated page on the presenter's phone | a live-mirror tunnel (tools/live/serve.py) + Cloudflare Access (`deploy-subdomain`) |
| approve/reply from a page to a running session | the `chat-with-agent-box` skill |
| wake a session on new data | Claude Code `Monitor` tool |
| a safe copy to rehearse on | `slide.py fork` |

New code would be: the phone capture page, the chunk-receiving endpoint, the
transcription worker, slide-position reporting from the presenting page, and
the session prompt.

## Open questions

- Does the presenter present from the presenter computer's editor, the live mirror, or the `teach` link?
  Only the first two can receive live edits today; `teach` cannot.
- Can the live mirror run polls during the lecture, or does presenting from it
  lose them?
- Is the PC's GPU good enough for local transcription in real time?
- the institution's policy on recording sessions.
