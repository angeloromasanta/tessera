# Tessera kernel

The app-agnostic machinery shared below the slides app: document lifecycle
(save/splice, encrypted-file support, autosave/version history), the i18n
engine, the animation engine, and charts-lite. The kernel/app boundary is
defined in `docs/PLATFORM.md` §6 — the kernel never sees an app's content
shape (slides, elements); it reads only the `KernelDoc` envelope
(`src/doc.ts`). There is no self-update: a shell changes only when a deck is
re-hosted with `scripts/upgrade-deck.mjs`.

## How it's consumed

Plain TypeScript source, no build step, no package.json. Apps import with
relative paths and explicit `.ts` extensions:

```ts
import { anim } from '../../kernel/src/anim.ts'
```

— the one convention that works identically in vite, `tsc` (bundler
resolution), and Node's native type stripping. In app code, prefer the app's
facade modules (e.g. `slides/src/save.ts`) over importing the kernel
directly; facades pin the app's configuration (and for i18n, guarantee
catalog registration order).

This is deliberately NOT an npm workspace: the kernel has zero dependencies,
so a workspace buys nothing (decision in `docs/DECISIONS.md`).

## Rules (see also ../CLAUDE.md and docs/OVERVIEW.md)

- Nothing here may import from an app directory. The dependency direction is
  app → kernel, only.
- New envelope fields on `KernelDoc` are platform decisions, not
  conveniences.
- Frozen contracts that live here: the `#tessera-doc` splice and the
  encrypted-file envelope (both `save.ts`). Treat every byte as shipped-file
  compatibility surface.

## Typecheck

```sh
slides/node_modules/.bin/tsc -p kernel
```

The app's `tsc -b` also typechecks kernel files transitively through its
imports.
