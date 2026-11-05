# Per-figure brief: template

<!-- Copy to $DECK_DIR/build/agents/NAME.md and fill in. `live_figures.py agent`
     sends AGENT_BRIEF.md (house style, live rules, checks, handback) BEFORE this,
     so write only what is specific to this figure. Aim for 40-80 lines. The
     sections are the questions agents otherwise answer wrongly or spend time on. -->

# Your figure: slide N, "<exact slide title>"
Your file: `$DECK_DIR/build/figures/NAME.html` (name = `NAME`).
Suggested example: `examples/<one file>.html`. Read only that one.
<!-- redo only: -->
The file holds an earlier draft. <Replace it / improve it, keeping X, Y, Z.>

## Audience and deck
<One line: who is in the room and what the deck is for, e.g. "first-year
undergraduates, first session of a year-long course".>

## The claim
<2-4 sentences: what the picture asserts. What contains what, and what causes what.
Say what it must NOT show (named problems, equations, a literal diagram).>

## Why the last version failed  <!-- redo only; the author's own words when you have them -->
- <each concrete defect: the agent can't see why the author disliked it>

## Visual
- <the main structure, where it sits in the 1280x480 viewBox, rough sizes>
- <marks and their colours, from the palette tokens>
- <what stays simple: prefer even spacing, abstract marks, one focal point>
- <reference image, if any: "last year's slide is attached / at build/check/x.png">

## Data  <!-- authoritative: the agent must not invent anything else -->
<the exact labels, dates, numbers>

## States  <!-- state 0 = on load; every click must MOVE something -->
0: <what shows on load>
1: <what enters, and HOW it moves (flies from / travels along / grows out of)>
...
N: <final state = the poster; complete and legible without a speaker>
<optional: the outro that loops back to state 0>

## Also used as  <!-- optional -->
<"The final state becomes a static image for the course page: shoot --clicks last --scale 2 to <path>">
