---
type: Pitfall
title: Don't hand-roll syntax checks; declare deliberate warnings once
description: figcheck already reports page script errors; a deliberate warning goes in the figcheck-allow meta, never for errors or fade-only.
tags:
- figcheck
- figcheck-allow
- syntax
- node
- warning
- state0
- coverage
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Hand-rolled `node -e` syntax checks: figcheck reports page script errors.
Deliberate warnings are declared once:
`<meta name="figcheck-allow" content="state0 coverage">` (never for errors
or `fade-only`).

`no-edit` (labels without `data-edit`) can be allowed the same way, but only
for a page that is not meant to be edited (a third-party page); for one live
value, `data-no-edit` on that node is the narrower fix.
