# brand-fonts

The two typefaces embedded in `template.html`. Build INPUTS, not app assets —
nothing in `slides/` imports them. `template/build_template.py` syncs these
bytes into the template's font assets and into every figure page that inlined
them.

| File | Becomes | Covers |
|---|---|---|
| `Fraunces-latin.woff2` | `doc.assets['title-font-latin']` | `U+0000–00FF` + punctuation/symbols |
| `Fraunces-latin-ext.woff2` | `doc.assets['title-font-latin-ext']` | Latin Extended-A/B |
| `Manrope-latin.woff2` | `doc.assets['text-font-latin']` | `U+0000–00FF` + punctuation/symbols |
| `Manrope-latin-ext.woff2` | `doc.assets['text-font-latin-ext']` | Latin Extended-A/B — Catalan `ŀ`, Central-European diacritics |

- **Fraunces** (titles), declared weight **`300 700`**: a variable instance of
  the google/fonts `ofl/fraunces` TTF with SOFT 0, WONK 0 and opsz 72 pinned,
  made by `build_title_font.py` (~67 KB for both subsets).
- **Manrope** (body and figures), declared weight **`200 800`**: Google ships it
  variable, so one file per subset serves every weight (400 body, 500/600
  labels, 700 emphasis). `add_licence_names.py` wrote the OFL licence records
  back into these subsets (the web-font subset had dropped them).

## Licensing

Both are [SIL OFL 1.1](https://openfontlicense.org) — free to embed and
redistribute, which is the whole requirement here: a deck carries its fonts
inside it and gets emailed around. Fraunces: Copyright 2020 The Fraunces
Project Authors (`Fraunces-OFL.txt`); Manrope: Copyright 2019 The Manrope
Project Authors (github.com/sharanda/manrope). Both name tables carry the
copyright and the licence.

A brand face replaces one of these only if its licence covers webfont
embedding **and** redistribution of the resulting document. A font pulled off
a random repository is not a licence; keep a commercial face out of this
repository and out of `template.html` altogether (a private brand kit embeds
its own).

## Replacing a face

1. Put the new `.woff2` subsets here and point `TITLE_FONTS` (in
   `template/build_template.py`) or `TEXT_FONTS` at them; update `palette.py`'s
   family names and font stacks.
2. Run `python template/build_template.py`: it embeds the bytes and swaps every
   inlined copy.
3. Search-and-replace the old family name in every element's `fontFamily` if
   the name changed, and delete the orphaned assets.
