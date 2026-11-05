# Template pictures

The three sample pictures in `template.html` (`img-coding`, `img-audience`,
`img-dashboard`), in an isometric low-poly voxel style. Generated with
`bytedance-seed/seedream-4.5` via OpenRouter (`tools/image_gen.py`), two
variants each, the better one kept and downscaled. No people or places they
depict are real.

- `img-coding.jpg` (4:3) — A blocky programmer character at a small desk typing on an open laptop whose screen glows with abstract coloured bars of code, a friendly little robot with a blue screen face beside the laptop pointing at the screen, a mug and a potted plant on the desk, seen from slightly above
- `img-audience.jpg` (1:1) — A small voxel lecture room seen from slightly above, rows of blocky students sitting in chairs, one student in the middle of the room raising a hand high, a small glowing blank speech bubble above the hand, nearby students turning to look, a lecturer figure at the front
- `img-dashboard.jpg` (4:3) — A blocky analyst character standing beside a large glowing screen showing an abstract rising line chart, small voxel bar-chart columns of different heights growing out of the desk in front of them, a laptop open on the desk, seen from slightly above

Swap one back in after replacing it (from the repository root):

    python tools/image_swap.py template.html img-coding=template/media/img-coding.jpg
    node scripts/stamp-agent-notes.mjs

`img-audience` sits contained on the `image` slide's tinted stage, so its
panel (`im-panel`, slide and layout) takes the picture's border backdrop,
`#F8F1DA`. After changing the picture: `python tools/panel_tint.py template.html --all`.

`posters/` holds the embed posters `template/posters.py` shoots from the
figure pages; they are regenerated, not edited.
