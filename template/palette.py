"""The template's palette, fonts and the re-token map used by build_template.py.

One place for every colour and family name the template ships with. The
builder, the splice and the docs read these; change a value here, re-run
`python template/build_template.py`, and every slide and every embedded
figure follows.

RETOKEN maps the palette of the figure family the template was first built
with (the house tokens --ink, --navy, --accent ... of the figure starter) onto
this palette. It is applied to text (element colours, figure CSS and JS), so a
figure written against the older tokens lands in the template's colours. It
is idempotent: no target value is also a source value.
"""
import re

# ---- type ------------------------------------------------------------------
TEXT_FAMILY = "Manrope"
TEXT_FONT = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
TITLE_FAMILY = "Fraunces"
TITLE_FONT = "Fraunces, Georgia, 'Times New Roman', serif"
MONO_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Courier New', monospace"

# ---- colour roles ------------------------------------------------------------
# name: (hex, role) -- the figure tokens use the same names as CSS custom properties
TOKENS = {
    "ink":         ("#1A2326", "all dark text"),
    "navy":        ("#0D2A2F", "deep: title/section backgrounds, dark fills"),
    "accent":      ("#0F6B73", "titles, structure, emphasis fills, arrows, header rules"),
    "band":        ("#13565D", "the diagonal band on section and hero slides"),
    "sky":         ("#2B6CB0", "a second hue, categories only"),
    "muted":       ("#5A6467", "secondary text, eyebrows, legends, footers"),
    "faint":       ("#A7AFB1", "disabled text"),
    "line":        ("#C7CFD1", "axes, dead marks"),
    "rule":        ("#D7DEDF", "hairlines"),
    "edge":        ("#E1E6E7", "card edges, table rules"),
    "tint":        ("#F1F5F5", "neutral card fill"),
    "blue-tint":   ("#E2F0F1", "accent tint"),
    "amber":       ("#BF831A", "highlight"),
    "amber-text":  ("#8E5F00", "highlight text"),
    "amber-tint":  ("#FCF0DA", "highlight fill"),
    "green":       ("#3B9457", "positive"),
    "green-text":  ("#2B7041", "positive text"),
    "green-tint":  ("#E3F2E6", "positive fill"),
    "coral":       ("#D2553A", "negative, warning"),
    "coral-text":  ("#A83A20", "negative text"),
    "coral-tint":  ("#FBE8E2", "negative fill"),
}
HEX = {k: v[0] for k, v in TOKENS.items()}

# categorical chart sequence (doc.theme.chartPalette): six mid-tones, each >= 3:1 on white
CHART = ["#2B6CB0", "#D2553A", "#7A5BBF", "#3B9457", "#C2477F", "#BF831A"]
CHART_NAMES = ["Blue", "Coral", "Violet", "Green", "Magenta", "Gold"]

THEME = {
    "background": "#FFFFFF",
    "color": HEX["ink"],
    "accent": HEX["accent"],
    "fontFamily": TEXT_FONT,
    "chartPalette": CHART,
    "table": {"headerBg": "transparent", "headerColor": HEX["muted"], "borderColor": HEX["edge"],
              "borderWidth": 1, "color": HEX["ink"], "fontSize": 16, "radius": 0, "cellPadX": 12,
              "cellPadY": 10, "rules": "rows", "headerRule": HEX["accent"], "headerCaps": True},
}

# ---- re-token map (older figure family -> this palette) ----------------------
RETOKEN = {
    "#131D41": HEX["ink"], "#000A3C": HEX["navy"], "#214A9F": HEX["accent"], "#1A4C9C": HEX["band"],
    "#4D88BE": HEX["sky"], "#5B6070": HEX["muted"], "#A9AEBD": HEX["faint"], "#C8CDD8": HEX["line"],
    "#D8DCE6": HEX["rule"], "#E2E4EC": HEX["edge"], "#F2F4F9": HEX["tint"], "#E6ECF7": HEX["blue-tint"],
    "#F8B837": HEX["amber"], "#9A6A00": HEX["amber-text"], "#FDF1D8": HEX["amber-tint"],
    "#00AD87": HEX["green"], "#00785D": HEX["green-text"], "#DFF4EE": HEX["green-tint"],
    "#F0585C": HEX["coral"], "#B3282D": HEX["coral-text"], "#FDE6E7": HEX["coral-tint"],
    # the light halves of the old chart pairs become the three extra chart hues
    "#F8AAAC": CHART[0], "#65CDB6": CHART[2], "#FCE3B0": CHART[4],
    # light text on the accent and band, greys of the flow slide and the slate category
    "#CDD6EE": "#CFE5E7", "#C6CEE4": "#C5DCDE", "#9BA6C4": "#93AFB2", "#8B90A0": "#8A9496",
    "#8A90A2": "#899395", "#C2C8D8": "#C1CBCD", "#DDE3EF": "#DCE7E8",
    # the evolution example's figure-local lineage hues, drifting toward the green
    "#12B48F": "#3F9A5C", "#2FBE9C": "#55A86E", "#55C4A4": "#6FB585", "#79C9B4": "#8CC39D",
    "#4B7BD0": "#3F72B8", "#D99A2B": "#C68A22",
    # the phone pages' own panel greys
    "#F2F3F7": HEX["tint"], "#DCDFE8": HEX["rule"], "#E8EDF7": HEX["blue-tint"],
}


def _rgb(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


_HEX_RE = re.compile("|".join(re.escape(k) for k in RETOKEN) + r"(?![0-9A-Fa-f])", re.I)
_RGB = {_rgb(k): _rgb(v) for k, v in RETOKEN.items()}
_RGB_RE = re.compile(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})")


def retoken(text: str) -> str:
    """Swap every old-family colour in TEXT (hex, rgb() and rgba()) for this palette's."""
    text = _HEX_RE.sub(lambda m: RETOKEN[m.group(0).upper()], text)

    def rgb(m):
        t = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if t not in _RGB:
            return m.group(0)
        head = m.group(0)[: m.group(0).index("(") + 1]
        return head + ",".join(map(str, _RGB[t]))
    return _RGB_RE.sub(rgb, text)


assert not set(v.upper() for v in RETOKEN.values()) & set(RETOKEN), "RETOKEN must be idempotent"
