"""Read the click-build animation out of a .pptx slide.

pptx_extract.py transcribes shapes but silently drops <p:timing>, so a slide
that reveals itself over eight clicks converts to a single static picture and
the whole argument of the slide is lost.

PowerPoint expresses one step two ways and you need both:

  <p:animEffect transition="in|out">   a fade
  <p:set> ... style.visibility          an instant show/hide

Reading only animEffect misses every exit written as a bare visibility set --
which is how PowerPoint ends a build that clears its scrims.

The step class lives on a <p:cTn> as presetClass, abbreviated "entr"/"exit"
(NOT "entrance" -- that spelling silently matches nothing).
"""
import zipfile
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _slide_xml(pptx, index):
    with zipfile.ZipFile(pptx) as z:
        return z.read(f"ppt/slides/slide{index}.xml")


def click_groups(pptx, index):
    """Per click, the ordered [(shape_id, 'in'|'out'), ...] it applies.

    Returns [] for a slide with no build.
    """
    root = ET.fromstring(_slide_xml(pptx, index))
    seq = root.find(f".//{{{P}}}timing//{{{P}}}seq")
    if seq is None:
        return []
    top = seq.find(f"{{{P}}}cTn")
    kids = top.find(f"{{{P}}}childTnLst") if top is not None else None
    if kids is None:
        return []
    groups = []
    for grp in kids:
        events = []
        for ctn in grp.iter(f"{{{P}}}cTn"):
            cls = ctn.get("presetClass")
            if cls not in ("entr", "exit"):
                continue
            tgt = ctn.find(f".//{{{P}}}spTgt")
            if tgt is not None:
                events.append((tgt.get("spid"), "in" if cls == "entr" else "out"))
        groups.append(events)
    return groups


def visibility_frames(pptx, index):
    """Cumulative set of visible shape ids after each click."""
    visible, frames = set(), []
    for events in click_groups(pptx, index):
        for sid, kind in events:
            visible.add(sid) if kind == "in" else visible.discard(sid)
        frames.append(set(visible))
    return frames


def summarize(pptx, index):
    """One compact transcript line, or '' when the slide is static.

    Cheap enough to emit for every slide -- this is what tells the editing pass
    that a slide is a build rather than a picture.
    """
    groups = click_groups(pptx, index)
    if not groups:
        return ""
    parts = []
    for i, events in enumerate(groups, 1):
        ins = [s for s, k in events if k == "in"]
        outs = [s for s, k in events if k == "out"]
        bit = f"{i}:+{len(ins)}"
        if outs:
            bit += f"-{len(outs)}"
        parts.append(bit)
    return f"BUILD {len(groups)} clicks [{' '.join(parts)}]"


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3 or sys.argv[1] in ("-h", "--help"):
        raise SystemExit("usage: python tools/pptx_timing.py DECK.pptx SLIDE_NUMBER\n\n" + __doc__)
    pptx, idx = sys.argv[1], int(sys.argv[2])
    print(summarize(pptx, idx))
    for i, f in enumerate(visibility_frames(pptx, idx), 1):
        print(f"  after click {i}: {len(f)} visible")
