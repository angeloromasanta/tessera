---
name: tessera-pptx
description: 'Convert a PowerPoint deck (.pptx) into a tessera HTML deck on a template. Use when asked to convert, port, redesign or turn a pptx or a presentation into a tessera deck. A four-pass pipeline: python extraction into a draft spec, editing that draft, python compilation, screenshot review.'
---

# PowerPoint to deck

**The pipeline is `$GUIDE/conversion.md`**: four passes (extract, edit the
draft, compile, look), the rule that the words are not yours, the raw
transcript and `text_audit.py`, which slides need a figure, landing each
rebuilt slide live. The spec format is `$GUIDE/reference/SLIDE_SPEC.md`.
Paths, setup and the general rules: the `tessera` skill.

- **The template** is `TESSERA_TEMPLATE` from `.env` (or a brand skill's
  template); ask only when the deck is for a different brand.
- **The words are the author's**: keep every text run (`text_audit.py`
  should report them all present); restructure the layout, never rewrite the
  content unless asked.
- **Pictured diagrams are the classic miss**: open every exported picture;
  anything with boxes, arrows, axes or labels is rebuilt as a figure
  (`tessera-figures`), never left as an image.
- Tell the person where each rebuilt slide landed as it lands.
