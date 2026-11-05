// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Minimal inline icon set (lucide-style, stroke = currentColor). No deps.

const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const ICONS = {
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  window: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
  presenter: svg('<rect x="3" y="4" width="18" height="14" rx="2"/><line x1="14" y1="4" x2="14" y2="18"/><line x1="16.5" y1="8" x2="18.5" y2="8"/><line x1="16.5" y1="11" x2="18.5" y2="11"/><line x1="16.5" y1="14" x2="18" y2="14"/><line x1="9" y1="21" x2="15" y2="21"/>'),
  slideshow: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><polygon points="10 7.5 15 10 10 12.5" fill="currentColor" stroke="none"/><line x1="12" y1="16" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>'),
  key: svg('<circle cx="8" cy="16" r="4"/><path d="M11 13 L20 4"/><path d="M15 9 l3 3"/>'),
  history: svg('<circle cx="12" cy="12" r="8.5"/><polyline points="12 7 12 12 15.5 14"/>'),
  send: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  notes: svg('<line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="14" y2="17"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  cloudCheck: svg('<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.48 1.46A3.75 3.75 0 0 1 17.25 18.5z"/><polyline points="9.5 13.5 11.5 15.5 15 12"/>'),
  cloudSync: svg('<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.48 1.46A3.75 3.75 0 0 1 17.25 18.5z"/><path d="M14.6 12.4a2.8 2.8 0 0 0-5-.6"/><polyline points="9.4 10.4 9.5 12 11.1 11.9"/><path d="M9.4 14.6a2.8 2.8 0 0 0 5 .6"/><polyline points="14.6 16.6 14.5 15 12.9 15.1"/>'),
  cloudOff: svg('<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 11.48 1.46A3.75 3.75 0 0 1 17.25 18.5z"/><line x1="12" y1="11" x2="12" y2="14"/><circle cx="12" cy="16.2" r="0.4" fill="currentColor"/>'),
  layers: svg('<polygon points="12 3 21 8 12 13 3 8 12 3"/><polyline points="3 13 12 18 21 13"/>'),
  maximize: svg('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  minimize: svg('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  stop: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M9.9 5.2A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><line x1="3" y1="3" x2="21" y2="21"/>'),
  play: svg('<polygon points="7 4.5 19 12 7 19.5" fill="currentColor" stroke="none"/>'),
} as const

