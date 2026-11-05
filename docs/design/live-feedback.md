# Live student feedback that reshapes the deck — design sketch

*Design document, 14 October 2026. Status: **idea, not implemented.** The presenter's
words: "each slide, students can give feedback such as questions or comments
on pace and then this is processed every x seconds improving the slides itself
or adding more slides to explain stuff." Companion to
`live-lecture.md`: same Claude loop and the same safety rules, but the
input comes from the room instead of the presenter's voice. The two combine well: the
transcript says what the presenter explained, the feedback says what did not land.*

## What it would do

On every slide, each student's phone shows a small feedback bar:

- **Pace**: too slow / fine / too fast — a setting the phone keeps, not a
  vote per slide.
- **"I'm lost"** — one tap, tied to the slide on screen.
- **Ask** — a free-text question or comment, also tied to the slide.

Every 15–30 s a script aggregates what came in. When something crosses a
threshold, a Claude session acts on it, from safest to boldest:

1. **Tell the presenter, change nothing.** A pace meter and a "lost on this slide:
   7 of 40" counter on the presenter's phone. Most of the value may be here, and it needs
   no AI at all.
2. **A Q&A slide** that Claude keeps rewriting: the questions so far, grouped
   by theme, duplicates merged, with a suggested answer for each in the
   speaker notes. The presenter opens it when taking questions.
3. **An explainer slide** inserted right after the current one when many are
   lost or several ask the same thing: a simpler wording, an example, an
   analogy, in the deck's own style. Offered as a proposal on the presenter's phone —
   "Insert explainer after slide 12? [Insert] [Skip]" — because the presenter's next
   click would otherwise show it unannounced.
4. **Patching upcoming slides**: if the room is lost on concept X, the next
   slides that build on X get a one-line recap. Also a proposal.
5. **Pace suggestions**: "the room says too fast — slides 14–15 are optional,
   skip?" Never acted on alone.

After the lecture: a per-slide confusion map and the question list, which is
the most direct revision brief a deck can get.

## Architecture

```
 student phones                 poll service (Cloudflare)          presenter computer
 ──────────────                 ─────────────────────────          ───────
 feedback bar ──POST──────────▶ feedback bucket ◀──GET (lecturer key)── aggregator.py
 {device, slideId?,             (anonymous)                             every 15–30 s
  kind, text, t}                                                          │ thresholds
                                                                          ▼
                                                              build/lecture/<date>/feedback.jsonl
                                                                          │
                                         Claude Code session ◀────────────┘ (Monitor)
                                           │ slide.py … live
                                           ▼
                                         open editor ──▶ live mirror = projector
                                           │
                                           └──▶ proposals + pace meter on the presenter's phone
```

### 1. The feedback bar

**Prototype without touching the engine:** a standalone page (Cloudflare
Worker or a live-mirror tunnel (tools/live/serve.py)) that students open from one QR on the title
slide and keep open. It does not know the slide; it timestamps each tap. The
aggregator learns which slide was on screen at each moment by reading
`currentSlideId` from the live editor (`agent_live.py read`) every few seconds
and keeping a timeline, then joins the two by time.

**Proper version, in the engine** (needs the maintainer's approval — `tessera`):

- the audience page already polls `/api/session` every 2.5 s to learn the
  on-screen question (`FORK.md` §1); the session would also publish the
  on-screen **slide id** on every slide, not only on poll slides,
- the audience page shows the bar beneath whatever it currently shows, so
  polls, labs and feedback live on one page and one QR,
- one feedback bucket per deck session, answers shaped
  `{slideId, kind: "pace"|"lost"|"ask", value}`,
- the presenter view gets the pace meter directly.

### 2. Aggregation — a script, not Claude

`aggregator.py` reads the bucket every 15–30 s with the lecturer key from
`.env` (`the lecturer key`, the same one freezing uses; never copied
anywhere else — see the poll-service rules in `FORK.md`). It computes, per
slide: lost count against the number of phones active, the pace balance, new
questions. It wakes Claude **only** when something crosses a threshold, e.g.:

- lost ≥ 20 % of active phones on the current slide,
- ≥ 3 questions on the current slide, or a new question after a quiet period,
- the pace balance tips past ⅓ either way for two consecutive windows.

That keeps Claude's work to a handful of decisions per lecture instead of one
every few seconds, and the thresholds can be tuned without touching the prompt.
The "every x seconds" in the idea is the aggregator's cadence; Claude's is
"when it matters".

### 3. The Claude loop

The same session as in `live-lecture.md` §4, woken by `Monitor` on
`feedback.jsonl`. Per wake-up it reads the event, the current slide and the next
three, the questions so far, and (if the recording runs too) the last minutes
of transcript — so an explainer does not repeat what the presenter just said. Then it does
one thing: update the Q&A slide, write an explainer proposal, write a recap
proposal, or log and wait.

An explainer slide is built as a new slide id (`slide.py … live`), tagged
`inserted-live` so it can be kept, edited or dropped after the lecture.
Writing one takes Claude roughly 30–60 s, so it is ready while the room is
still on the slide or the next one.

## Rules

Everything in `live-lecture.md` ("Rules the loop must follow"), plus:

- **Student text never reaches the screen unfiltered.** Questions are
  paraphrased and grouped; anything rude, personal or off-topic is dropped.
  No names, ever — the bar is anonymous.
- **One device, one "lost" per slide**, and thresholds relative to the phones
  active, so two students cannot steer the deck.
- **At most N inserted slides per lecture** (start with 3), and never two in a
  row.
- **Pace feedback never edits a slide.** It informs the presenter, who decides.
- Clearing or rehearsing uses the bucket, never a changed code
  (poll codes are hard-coded in figures).

## After the lecture

The session writes `build/lecture/<date>/feedback-report.md`: confusion per
slide (where the room got lost), the grouped questions with the answers the presenter gave
(from the transcript, if recorded), the explainers inserted and whether the presenter showed
them, and a revision list for the deck. The `inserted-live` slides the presenter wants to
keep are folded into the spec or the deck; the rest are removed. A version of the
Q&A goes to students as a recap.

## Build order

1. **Offline rehearsal.** Replay synthetic feedback (and a real transcript, if
   the first idea's rehearsal exists) against a forked deck (`slide.py fork`).
   Tune thresholds and the explainer prompt until the presenter would keep the output.
2. **Standalone feedback page + pace meter + post-lecture report.** No live
   edits. Tells us whether students actually use the bar.
3. **Q&A slide, then explainer proposals** approved from the presenter's phone.
4. **Move the bar into the engine's audience page** (approval needed) once the
   prototype has proved it is worth one QR and one page.

## Pieces that already exist

| need | existing piece |
|---|---|
| phones that follow the on-screen slide | the audience page + `/api/session` (`FORK.md` §1) |
| anonymous answers in a bucket, read with the lecturer key | the poll service, `server/poll-app/` |
| a room-state bar (Lost / Working / Finished) | the lab slides in `engage` — the closest model for the UI |
| grouping free-text answers | the frozen-hive clustering (`_cluster.js`) |
| insert and edit slides in the open deck | `slide.py … live`, `agent_live.py` |
| proposals and replies on the presenter's phone | the `chat-with-agent-box` pattern |

## Open questions

- Will students keep a page open and use it, or does it need to be the same
  page they already have for polls? (Stage 2 answers this.)
- Does an explainer interrupt more than it helps? He may prefer them collected
  on the Q&A slide only.
- What happens at a large class of ~160 — the bucket caps (500
  answers per bucket) would need a feedback-specific limit.
