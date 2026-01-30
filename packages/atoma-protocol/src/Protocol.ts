import { error } from './core/error'
import { http } from './transport/http'
import { ids } from './ids'
import { ops } from './ops'
import { sse } from './transport/sse'
import { collab } from './collab'

export const Protocol = {
    http,
    error,
    ids,
    ops,
    sse,
    collab
} as const
