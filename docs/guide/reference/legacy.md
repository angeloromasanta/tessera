# Legacy names

Decks written before the rename use these names. Every reader (the editor,
the poll service, the tools) takes the new name first and the old one second;
every writer writes the new name. Never write an old name into a deck or a
page.

| new | old |
|---|---|
| `<script type="application/tessera+json" id="tessera-doc">` | `application/bento+json`, `id="bento-doc"` |
| format `tessera/slides` | `bento/slides` |
| `window.TESSERA_EMBED`, `TESSERA_ACTIVITY`, `TESSERA_REFIT`, `TESSERA_STEPPED`, `TESSERA_STEPS` | `BENTO_EMBED`, `BENTO_ACTIVITY`, `BENTO_REFIT`, `BENTO_STEPPED`, `BENTO_STEPS` |
| `window.TesseraGame`, `<meta name="tessera-game">` | `window.BentoGame`, `<meta name="bento-game">` |
| `<meta name="tessera-offline-ok">`, `<meta name="tessera-activity">` | `bento-offline-ok`, `bento-activity` |
| headers `x-tessera-lecturer`, `x-tessera-player`; device id `tessera-device` | `x-bento-lecturer`, `x-bento-player`, `bento-device` |
| browser storage keys `tessera-*` (copied once from the old keys, which are left untouched) | `bento-*` |
| env `TESSERA_AGENT`, `TESSERA_NO_LIVE`, `TESSERA_CHROME_NO_SANDBOX`, `TESSERA_LECTURER_KEY` | `BENTO_AGENT`, `BENTO_NO_LIVE`, `BENTO_CHROME_NO_SANDBOX`, `BENTO_LECTURER_KEY` |
| tools `md_to_deck.py`, `deck_build.py`, `export_deck.py` | `md_to_bento.py`, `bento_deck.py`, `export_bento.py` |
| player shell `slides/dist-single/tessera.html` | `Bento_Slides.bento.html` |
| layout ids by role (`points`, `poll`, …; any `<prefix>-<role>` also works) | brand-prefixed ids, still matched by role |
