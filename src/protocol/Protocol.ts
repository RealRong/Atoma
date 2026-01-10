import { error } from './shared/error'
import { http } from './ops/http'
import { ids } from './shared/ids'
import { ops } from './ops/ops'
import { sse } from './shared/sse'

export const Protocol = {
    http,
    error,
    ids,
    ops,
    sse,
    collab: {}
} as const

