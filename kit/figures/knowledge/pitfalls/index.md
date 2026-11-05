# pitfalls

- [add-slide double-escaped the footer](/pitfalls/add-slide-footer-escaping.md) - deck_build.py add-slide produced &amp;amp; in the copied footer; copy the footer html from a neighbour afterwards.
- [Where figure-agent tokens go](/pitfalls/agent-token-costs.md) - Six-agent audit: silent coordinate thinking, retyped engines, reading every doc, info dumps, contact sheets, whole-file rewrites; and the shortcut for each.
- [Chrome cannot start its sandbox inside Codex's](/pitfalls/chrome-sandbox-in-codex.md) - shoot.py and figcheck.py retry with --no-sandbox after ~12 s by themselves; write no shims.
- [Codex resume: silent planning and sandbox flags](/pitfalls/codex-resume.md) - A resumed agent plans silently, so revise asks for a rough version in ~2 minutes; resume takes no -s, so revise passes sandbox_mode.
- [Don't hand-roll syntax checks; declare deliberate warnings once](/pitfalls/figcheck-allow.md) - figcheck already reports page script errors; a deliberate warning goes in the figcheck-allow meta, never for errors or fade-only.
- [shoot.py --only N stalls on an embed](/pitfalls/shoot-only-stalls-on-embed.md) - The frame takes the arrow keys; use shoot.py DECK --id ID or check the poster.
- [Keep figure sources in git](/pitfalls/track-figure-sources.md) - Hand-authored build/figures/*.html are tracked; font copies, live.log and agent logs are disposable.
