---
name: tessera-engage
description: 'Build audience-engagement slides in a tessera deck: the room answers on their phones and the slide reports back live. Use when asked for a poll, a live vote, a word cloud or clustered open answers, a rating, a quiz or knowledge check, attendance or a check-in, a classroom game, an icebreaker, a slide the audience rewrites with AI, a Mentimeter-, Slido- or Kahoot-style question, or anything the audience should answer, vote on, react to or play during a talk; also showing one slide''s answers on a later slide.'
---

# Audience engagement

**The method is `$GUIDE/engagement.md`** (the kinds, codes, the wire
contract, reading answers back, activity pages and games, rehearsing,
presenting, troubleshooting) and **`$GUIDE/engagement-pages.md`** (the
ready-made pages: guess the number, lab slides with timer and room check, the
interactive title, the game starter, groups). Paths, setup and the general
rules: the `tessera` skill.

## Pick, then copy

- **The five kinds** (`engagement.md`, "Pick the kind"): `open` (free text,
  summarized or clustered live), `choice`, `rating`, `quiz` (several
  questions; the slide shows the score spread and the correct answers never
  leave the deck) and `activity` (a whole page the deck ships to every phone:
  a game, a custom form).
- **Start from a worked slide** in the template rather than from nothing
  (`$PY $T/slide.py ls "$TESSERA_TEMPLATE"` lists them: plain polls, a live
  clustered "hive", answers placed on axes, a lab with timer and AI helper,
  games). `slide.py copy` gives the copy a fresh answer code; a hand copy must
  do it itself (`engagement.md`, "Codes").

## The rules that cost money or a class

1. **Every read counts** (`engagement.md`, "Every read counts"), without
   exception: never a page that re-reads answers on a timer. A poll service on
   a free plan has a daily limit shared by everyone using it; past it, polls
   stop for everyone until the reset.
2. **The lecturer key** (`engagement.md`, "The lecturer key: one rule") lives
   only in `.env` and in the presenter's browser. Never print it or put it in
   a deck, a page or a test, and never seed or clear a bucket a real deck uses.
3. **Collecting answers needs a poll service**: the deck's
   `doc.poll.service` (set up once: `$TESSERA/docs/server-setup.md`). Without
   one the poll shows but nothing comes back; say so rather than building a
   game the room cannot play.
4. **Rehearse on a scratch fork** (`engagement.md`, "Rehearsing without a
   room"), never on a real deck's buckets.
5. Treat questions and answers as public: the join code is on the projector.
