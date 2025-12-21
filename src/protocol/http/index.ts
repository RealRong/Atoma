import { parseStandardEnvelope } from './parser'
import * as httpCompose from './compose'

export const http = {
    parse: {
        envelope: parseStandardEnvelope
    },
    compose: {
        ok: httpCompose.ok,
        error: httpCompose.error
    }
} as const

export type { StandardEnvelope } from './envelope'
