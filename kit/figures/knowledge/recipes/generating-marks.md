---
type: Recipe
title: Generating marks in JS
description: Build repetitive marks (rings, bands, grids) in JS with the starter's mk/pill helpers and paint layers instead of typing them.
tags:
- mk
- pill
- layers
- generate
- group
- getBBox
status: stable
generated:
  by: process:recipes-md-migration
  at: '2026-10-04T12:00:00Z'
---

Anything repetitive — a ring of nodes, five bands under a curve, a grid — is
cheaper to build than to type, and a built figure rescales by editing one
constant. Append the marks **above** the engine block, so `.el` is populated
before the engine queries it. The starter (`assets/figure.html`) already
defines the helpers:

```js
mk(tag, attrs, parent)                 // parent defaults to layer.shapes
pill(id, text, x, y, {anchor, color})  // label in a white pill sized from getBBox
layer.links / layer.shapes / layer.labels   // paint order: lines, boxes, text
```

A plain label is `mk('text', {class: 'el lbl', id, x, y}, layer.labels)` then
`.textContent = '...'`. Need its size for the next placement? `getBBox()` it
right there, instead of estimating characters times a width.

Give every generated element the id the `steps` array will name (`mk('path', {
class: 'el draw', id: 'a12', … })`). Group a box + its text under one `<g
class="el" id="n1">` so a step names one id, not three.
