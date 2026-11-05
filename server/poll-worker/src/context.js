// Which Durable Object is handling the current request. _lib.js reads it so a
// handler's getPoll(code) is a local SQLite read when `code` is this object's
// own, and an RPC to the right object otherwise.
import { AsyncLocalStorage } from 'node:async_hooks'

export const current = new AsyncLocalStorage()
