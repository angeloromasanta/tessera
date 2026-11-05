# recipes

- [Filled bands under a computed curve](/recipes/bands-under-curve.md) - Sample f(x) once, close each band back to the baseline, draw the outline on top; a cumulative overlay is the running sum.
- [Something born out of something else](/recipes/born-out-of.md) - A child mark grows out of its parent: author it at its final place, offset it back with a CSS transform that .on removes.
- [A camera, and when to relayout or morph instead](/recipes/camera-or-relayout.md) - Camera when the same picture comes nearer, relayout when the detail view differs, morph when marks rearrange; never the camera to highlight a few of many.
- [deck_build.py embed slides (offline decks only)](/recipes/deck-embed-slide.md) - add-slide / update-slide / remove-slide an embed in a deck file with no spec and no live editor, with an auto-shot poster.
- [`do`: anything else that changes rather than enters](/recipes/do-escape-hatch.md) - The escape hatch for a box height, a counter or running flows: a named field of your own on the step, applied by do.
- [Generating marks in JS](/recipes/generating-marks.md) - Build repetitive marks (rings, bands, grids) in JS with the starter's mk/pill helpers and paint layers instead of typing them.
- [A stream of glyphs riding a wire](/recipes/glyph-stream.md) - Data moving over a link as a textPath of digits on its own inset rail, drawn left-to-right, offset kept in [-pitch, 0].
- [A box sized from what it holds](/recipes/growing-box.md) - Show growth by animating a box's height (SVG geometry is CSS-animatable), deriving the outer box from the inner one.
- [Motion beyond a fade](/recipes/motion-beyond-fade.md) - Self-drawing curves in segments, marching ants around a loop, a hatched region, and what tweens in SVG.
- [Pose: where a mark IS in this step](/recipes/pose.md) - The step field pose {id: {x, y, s, r}} moves, scales and turns marks already on screen; values may be functions measured at step time.
- [The same marks, a different meaning](/recipes/re-read-marks.md) - dim, dead and sel re-read the picture instead of adding to it; a re-read-only step warns `still` and may be right.
- [A ring of nodes with arcs that touch the boxes](/recipes/ring-of-nodes.md) - Ellipse layout of nodes with arcs clipped to each box edge, sweep direction and a shared arrowhead marker (flywheel, cycle).
- [Seeing motion in screenshots](/recipes/seeing-motion.md) - Screenshots show resting states; re-shoot moving states with --settle 0.28 to prove a flow runs or a camera arrives.
- [A three-state engine: on / dead / sel](/recipes/three-state-engine.md) - Steps with on/dead/sel lists so marks can read as failed or chosen, not just shown; leave failures on screen, greyed.
- [Zoom as spotlight: a few of many (worked)](/recipes/zoom-as-spotlight.md) - A few of many: the chosen marks swell in place with pose: spotlight(ids, 2.5) and dim the crowd; pick them by hand, scattered.
