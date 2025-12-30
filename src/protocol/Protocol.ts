import { error } from './error'
import { http } from './http'
import { ids } from './ids'
import { ops } from './ops'
import { jsonPatch } from './jsonPatch'
import { sse } from './sse'

export const Protocol = {
    http,
    error,
    ids,
    ops,
    jsonPatch,
    sse,
    collab: {}
} as const
