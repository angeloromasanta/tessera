# public/lib — vendored libraries for game pages

Served as static assets at `SERVICE/lib/NAME.js` (free, no Worker run). A page
loads one with `TesseraGame.lib(name)` or a plain script tag, so a 60 000-char
activity page no longer has to carry it. Fetched unmodified from
`https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>` on 2026-10-22; to upgrade,
fetch the new pinned version the same way and update this table.

| file | package | version | source path | licence | global |
|---|---|---|---|---|---|
| `confetti.js` | canvas-confetti | 1.9.3 | `dist/confetti.browser.js` | ISC | `confetti` |
| `matter.js` | matter-js | 0.20.0 | `build/matter.min.js` | MIT | `Matter` |
| `d3.js` | d3 | 7.9.0 | `dist/d3.min.js` | ISC | `d3` |
| `chart.js` | chart.js | 4.4.4 | `dist/chart.umd.js` | MIT | `Chart` |
