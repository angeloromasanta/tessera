---
name: tessera-pictures
description: 'Find or generate a picture for a tessera slide, and put it on the slide or swap it into a deck. Use whenever a slide needs a picture, a deck should be more visual, a points or content slide becomes an image slide, or someone asks to find, source, search for or generate an image, photo, illustration or hero picture for a presentation, even without naming a source or a model.'
---

# Pictures for slides

**The tools and their use are `$GUIDE/pictures.md`**: searching
(`image_find.py`, licences, credits), generating (`image_gen.py`, what image
models draw badly, how to write the scene), swapping into a deck
(`image_swap.py`), which layout for which picture, the checklist. Paths,
setup and the general rules: the `tessera` skill.

## Which source

1. **Generate illustrative pictures** (a scene, a mood, a concept, a hero
   image), all in **one style per deck**: the style the workspace or a brand
   skill names (a style file); otherwise ask once and keep it.
   - **Your own image tool first**, if your harness has one (Codex and
     ChatGPT can generate images, for example): put the whole style text
     before the scene, ask for 16:9 unless the box is squarer, save the file
     in `$DECK_DIR/build/media/`, add a line for it to
     `build/media/CREDITS.md`, then place it like any other picture.
   - **Otherwise `image_gen.py`**, which needs the person's own
     `OPENROUTER_API_KEY` in `.env`; pass the style every time
     (`--style-file FILE`). It costs money on their key: ask first.
   - **Neither available**: search instead (below), or leave a clearly
     marked placeholder and say so.
2. **Search for a real picture** only when the slide must show the real
   thing (a figure from a named paper, a real product, place, building or
   event): `image_find.py`, no key needed. Credit it on the slide when the
   licence asks.

## Always

- No text in a generated picture (image models draw letters badly; end every
  style with "no text, no letters, no logos of any kind"); the slide carries
  the words.
- Never generate a real person, a real logo or a fake photograph of a real
  event.
- A picture **of a diagram** is not a picture: rebuild it as a figure
  (`tessera-figures`).
- Look at the result on the slide (`shoot.py DECK.html --id ...`): a cover
  crop keeps the middle of the picture.
