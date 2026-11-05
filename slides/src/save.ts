// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Facade: self-save + encrypted-file support live in the shared kernel now
// (kernel/src/save.ts). This path stays alive so slides code keeps importing
// './save' unchanged — see docs/PLATFORM.md §9.
export * from '../../kernel/src/save.ts'
