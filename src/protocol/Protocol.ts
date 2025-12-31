import { error } from './error'
import { http } from './http'
import { ids } from './ids'
import { ops } from './ops'
import { sse } from './sse'

export const Protocol = {
    http,
    error,
    ids,
    ops,
    sse,
    collab: {}
} as const
