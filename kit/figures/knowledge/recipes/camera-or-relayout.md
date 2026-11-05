---
type: Recipe
title: A camera, and when to relayout or morph instead
description: Camera when the same picture comes nearer, relayout when the detail view differs, morph when marks rearrange; never the camera to highlight a few of many.
tags:
- cam
- camera
- camFit
- zoom
- relayout
- morph
- push-in
- framing
- off-camera
status: stable
sources:
- resource: /corrections/2026-10-05-make-dynamic-meant-api-call.md
generated:
  by: claude-code/agent
  at: '2026-10-22T13:39:14Z'
---

A camera is one shared transform on the group holding everything. That makes it
the degenerate case of moving marks: the same thing every per-mark transform
would do, when the transform happens to be identical for all of them. So the
question is never "camera or morph", it is **does the layout change?**

| | |
|---|---|
| the design **holds at both scales** and you want it closer | **camera** — relative positions preserved by construction, one line instead of N, nothing can drift out of sync |
| the detail view wants a **different arrangement** — the box goes full width, a row becomes two, the neighbours leave | **relayout** — give each mark a target per step and let the ones that do not belong translate off-slide |
| marks **rearrange in place** — a band breaks into its seats, a scatter sorts into a histogram | **morph** — per-mark positions. No camera can do this; the relationships themselves change |

Relayout is the honest alternative to a camera and is often the better picture:
a magnified design is one design seen twice, a relaid-out one is designed for
both. It also removes the camera's worst failure mode — **a mark either has a
target or is told to exit, so nothing is ever cropped by accident.** Most
framing bugs in a camera figure are exactly that accident.

Its cost is that a *uniform* relayout — every mark taking the same scale and
offset — is a camera written out N times, and it drifts the moment one mark's
numbers are wrong. So: relayout when the detail view genuinely differs, camera
when it is the same picture nearer. All three `api-call.html` framings are the
second kind; the strips do not rearrange, the frame just closes in.

The camera's cost is that it pushes everything else off-frame. That is right
when it is a turn of the head — "now we are looking at the disk, not the
network" — and wrong when the audience must keep sight of where the subject
came from. **To highlight a few of many, do not use the camera**: grow those
marks in place and grey the rest, so the picture they came out of stays on
screen ([zoom as spotlight](/recipes/zoom-as-spotlight.md), and `docs/figures.md`, "Motion rules"). A camera there would throw away the crowd that made
the point.

The starter has `camFit(ids, pad)` / `camTo(rect)`. Two things to know.

**Name the marks, don't type the rect.** `cam: () => camFit(['ncode','gate'])`
reads their boxes at step time and returns a rect matched to the frame's
aspect. A hand-typed rect whose aspect differs from the frame's silently wastes
margin — cap the zoom and the push-in barely moves — and a rect typed from
memory is how the subject of the beat ends up just outside it. Pass a
*function*, not an array, so it measures after the fonts land.

**A zoom is a turn of the head, so everything else should be gone or clearly
behind.** A mark parked in a gutter — a rail, a legend — lands in frame at 2x
as a giant intruder. Either put it inside the card it annotates, or leave it
off. `figcheck` errors on a mark that switches *on* outside the camera frame,
but says nothing about one that was already on and is still there.

Frame the whole thing again (`FULL`) before the final state: that is the frame
the poster is shot in.

**"Make it dynamic" means this vocabulary, not a new layout.** When
the author asks for more motion in a figure they already approved, keep the approved
layout as the opening states; change layout on a click by releasing a pose so
the same marks travel there; add `api-call.html`'s vocabulary: a camera per
beat, typed text, digit streams only on hops that cross a boundary. Re-laying
out the whole figure from state 0 replaced an opening they liked.
