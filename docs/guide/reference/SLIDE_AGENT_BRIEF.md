# Slide agent brief (template: the coordinator fills in the {braces})

You are **{agent}**. You edit only these slides of one deck: **{ids}**.
Other agents are editing other slides of the same deck right now, and the
person is watching each of your pushes appear in their open editor. Don't load
any skill, and don't read tool source (`--help` is enough).

**Every shell call is a fresh shell:** variables and `export` do not survive
to the next call. Write each command in full (`{T}` below is the real path of
the tools folder; the coordinator fills it in), and put **`--agent {agent}`
on every `slide.py` command**: it is how the editor names you and how your
claim lets your pushes through.

```
python {T}/slide.py get {target} ID --agent {agent}           # one element per line
python {T}/slide.py text {target} ID ELEM "…" --agent {agent}  # \n = line break; --html for markup
python {T}/slide.py notes {target} ID "…" --agent {agent}
python {T}/slide.py set {target} ID ELEM x=56 y=196 w=1128 h=400 fontSize=24 --agent {agent}
python {T}/slide.py pull {target} ID --agent {agent}  →  Edit build/work/ID.json  →  … push {target} ID --agent {agent}
python {T}/shoot.py {target} --id ID                 # → <deck>/build/shots/ID.png, then read it
python {T}/icon.py NAME --x 56 --y 196 --size 44 --color "{accent}"   # prints a path element to add
python {T}/image_gen.py --deck {deck_file} --name NAME {style} "subject"  # picture → build/media/NAME.jpg
python {T}/slide.py asset {target} img-NAME <that file> --agent {agent}   # then set ID ELEM src=asset:img-NAME
```

## Your slides

{per-slide: id, what it must say, sources, and the element choice: chart / table / points columns / image / morph with the previous slide}

## Rules (the full list is the guide's `authoring.md`, needed only if you're unsure)

- Keep every existing element id. Add new elements with new, descriptive ids.
  Never change ids or poll codes.
- Content spans x=56 to 1184. Titles use the layout's title element. Body text
  is the deck's body face; don't add fonts or colours outside the palette
  already on the slide.
- A list is ONE text box with a `• ` line per bullet. Numbers that compare go
  in a `chart`. A grid of values goes in a `table`.
- Speaker notes on every slide: the talk track, 2–5 sentences, with sources
  where claims are made.
- Standing rules for this deck: {README rules}

## Loop, with at most 2 revisions per slide

**Draft first**: a new or reworked slide gets a rough but working version
pushed within ~2 minutes (regions as boxes, placeholder text), then layout →
real content → polish, pushing after each.

1. `get` your slide.
2. Edit it: small edits with `text`, `notes` or `set`; larger ones with
   `pull` → Edit → `push`.
3. `shoot.py --id` your slide and look at the PNG. Check for clipped text,
   overlaps, empty placeholders and anything past x=1184.
4. Fix and shoot once more, then stop.

- **On `conflict`:** someone changed the same field. `get` again, redo only
  that part, push.
- **On "claimed by":** you touched a slide that isn't yours. Don't.
- Never add, delete or reorder slides. Ask the coordinator in your report.

## Report (your final message, at most 10 lines)

- Per slide: what it now shows, and anything you couldn't do.
- The paths of your final shots.
- Anything the coordinator must decide (a missing source, a cross-slide
  morph).
