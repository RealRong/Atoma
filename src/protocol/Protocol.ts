import { error } from './error'
import { http } from './http'
import { ids } from './ids'
import { ops } from './ops'
import { jsonPatch } from './jsonPatch'
import { sse } from './sse'
import { trace } from './trace'

export const Protocol = {
    http,
    trace,
    error,
    ids,
    ops,
    jsonPatch,
    sse,
    collab: {}
} as const
