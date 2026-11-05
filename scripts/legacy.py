"""Old names: decks written before the rename use these names.

Read by agent-bridge.py (loaded by path, so it never shadows tools/legacy.py).
Nothing else in scripts/ spells them: readers take the new name first and one
of these second; writers write the new name; nothing old is deleted.
"""

# the document block of a deck file saved before the rename
DOC_ID = "bento-doc"
DOC_TYPE = "application/bento+json"
DOC_OPEN = f'<script type="{DOC_TYPE}" id="{DOC_ID}">'

# the bridge's environment and state folder before the rename
ENV = {"TESSERA_AGENT_PORT": "BENTO_AGENT_PORT", "TESSERA_AGENT_STATE": "BENTO_AGENT_STATE"}
STATE_DIR_NAME = "BentoAgent"
