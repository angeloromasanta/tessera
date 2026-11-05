# corrections

- [a figure's right arrow would not leave the slide](/corrections/2026-09-16-right-arrow-would-not-leave-slide.md) - A wrapping keydown handler kept the arrow key from reaching the deck; copy the starter's clamped handler and TESSERA_STEPPED verbatim.
- [agents move 1 tile per tick is important](/corrections/2026-09-24-agents-move-one-tile-per-tick.md) - Smoothing a grid simulation changed its semantics; keep discrete cardinal tile steps and the source tick.
- [slides are crashing, like slide 6](/corrections/2026-09-28-slides-crashing-base64-page-asset.md) - Replacing a page asset with slide.py stored a base64 data URI; an embed asset must be raw HTML starting <!DOCTYPE.
- [it is not loaded to the slide and I need to present to show it](/corrections/2026-10-01-not-loaded-to-slide-until-present.md) - A failed liveInEditor step left the template's poster in the editor; re-run all of route A and check liveInEditor true.

## Superseded

- [figures must move, not fade](/corrections/2026-09-16-figures-must-move-not-fade.md) -> /recipes/pose.md
- [the zoom drew a second, bigger copy somewhere else](/corrections/2026-09-16-zoom-drew-second-bigger-copy.md) -> /recipes/zoom-as-spotlight.md
- [folder names stacked in one place on the slide, fine in the page shot](/corrections/2026-10-01-measured-pose-stacked-in-deck.md) -> /recipes/pose.md
- [Make it dynamic: the author meant the api-call kind of motion, not a rearranged layout](/corrections/2026-10-05-make-dynamic-meant-api-call.md) -> /recipes/camera-or-relayout.md
