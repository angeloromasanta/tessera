"""Old names, read so that existing decks and setups keep working.

Decks written before the rename use these names. Nothing outside this file
spells them: every reader takes the new name first and one of these second;
every writer writes the new name.
"""
from __future__ import annotations

# the document block of a deck file
DOC_ID = "bento-doc"
DOC_TYPE = "application/bento+json"
FORMAT = "bento/slides"             # doc["format"]

# the player shell the engine build wrote before the rename
SHELL_NAME = "Bento_Slides.bento.html"

# figure pages: how many clicks a page steps through, when it says so
STEPS_GLOBAL = "BENTO_STEPS"

# globals the deck shell hands a page, and the page hands back
EMBED_GLOBAL = "BENTO_EMBED"        # what an embed page receives (texts, poll, editable)
ACTIVITY_GLOBAL = "BENTO_ACTIVITY"  # what a phone's activity page receives (code, name, player)
POST_KEY = "bento"                  # postMessage {bento: kind} from the shell / a page
REFIT_GLOBAL = "BENTO_REFIT"        # page callback: re-wrap after a label edit
STEPPED_GLOBAL = "BENTO_STEPPED"    # page flag: it takes the step keys itself
APP_GLOBAL = "bento"                # window.<name>: the app object of an older shell
GAME_GLOBAL = "BentoGame"           # the game SDK object
GAME_META = "bento-game"            # <meta name="..."> that asks for the game SDK
AI_TAG = "bento-ai"                 # <script id="..."> holding a page's AI task prompts
OFFLINE_META = "bento-offline-ok"   # <meta name="..."> a page that runs without the service
ACTIVITY_META = "bento-activity"    # <meta name="..." content="full">: a phone page that fills the join page

# request headers the poll service read before the rename (it still does)
LECTURER_HEADER = "x-bento-lecturer"
PLAYER_HEADER = "x-bento-player"

# environment variables: new name -> old name, read when the new one is unset
ENV = {
    "TESSERA_AGENT": "BENTO_AGENT",
    "TESSERA_NO_LIVE": "BENTO_NO_LIVE",
    "TESSERA_CHROME_NO_SANDBOX": "BENTO_CHROME_NO_SANDBOX",
    "TESSERA_LECTURER_KEY": "BENTO_LECTURER_KEY",
    "TESSERA_GAME_SDK": "BENTO_GAME_SDK",
}

# file names the tools had before the rename
TOOLS = {
    "md_to_bento.py": "md_to_deck.py",
    "bento_deck.py": "deck_build.py",
    "export_bento.py": "export_deck.py",
}
