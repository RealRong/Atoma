import { batch } from './batch'
import { error } from './error'
import { rest } from './rest'
import { sync } from './sync'
import { trace } from './trace'

export const Protocol = {
    batch,
    rest,
    sync,
    trace,
    error,
    collab: {}
} as const
