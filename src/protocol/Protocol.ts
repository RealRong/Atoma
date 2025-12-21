import { batch } from './batch'
import { error } from './error'
import { http } from './http'
import { rest } from './rest'
import { sync } from './sync'
import { trace } from './trace'
import { vnext } from './vnext'

export const Protocol = {
    batch,
    http,
    rest,
    sync,
    trace,
    error,
    vnext,
    collab: {}
} as const
