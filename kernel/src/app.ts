// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Tessera authors (see LICENSE)
// Per-app identity for the kernel. Every app calls configureApp() once,
// first thing at boot, before any kernel module is used.
//
// The one app-specific value the kernel needs is the display name that
// appears in window titles and save dialogs. Everything else in the kernel is
// app-agnostic.

export interface AppConfig {
  /** Human-facing product name: window title suffix, save-picker label. */
  appName: string
}

let config: AppConfig | null = null

/** Called once at boot, before kernel modules are used. */
export function configureApp(cfg: AppConfig): void {
  config = cfg
}

/** The active app config. Throws if the app forgot to configure itself. */
export function appConfig(): AppConfig {
  if (!config) throw new Error('tessera kernel: configureApp() was never called')
  return config
}
