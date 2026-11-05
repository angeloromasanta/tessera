# Docs

Engineering documentation for the Tessera engine. Start with `OVERVIEW.md`.

| Document | What it covers |
|---|---|
| [OVERVIEW.md](OVERVIEW.md) | **What Tessera adds (polls, embeds, activities, games, the AI-native editor, the poll service, the agent bridge), how it is wired, the gotchas that must not regress, open issues.** Read before non-trivial work |
| [DECISIONS.md](DECISIONS.md) | Append-only decision log. Read before reopening a settled question; append when you settle one others could contradict |
| [PLATFORM.md](PLATFORM.md) | The invariants every build must honor: the splice contract, `docId`, format additivity. Breaking one bricks files already on disk |
| [format.md](format.md) | Normative reference for the document model: every element type, slide/state/layout shape, `fx`, file modes |
| [architecture.md](architecture.md) | How a deck file is built, its on-disk anatomy, the self-save loop, the runtime layout, tab-to-tab sync |
| [agent-live.md](agent-live.md) | The local agent bridge: live patches to an open deck, change requests, saving and validation |
| [game.md](game.md) | The game SDK and slide messages contract |
| [collab-design.md](collab-design.md) | The in-house CRDT that keeps tabs of one deck in sync |

Elsewhere:

- [guide/](guide/) is the authoring guide (deck anatomy, tools, figures, polls and games, publishing); [guide/reference/](guide/reference/) holds the format guide for agents.
- [server-setup.md](server-setup.md) deploys the poll service.
- [../CLAUDE.md](../CLAUDE.md) is the working agreement for this repo.
- [../CHANGELOG.md](../CHANGELOG.md) is the version history.
- [../server/poll-worker/README.md](../server/poll-worker/README.md) covers the poll service.
