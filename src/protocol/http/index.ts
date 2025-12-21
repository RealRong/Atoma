import { parseStandardEnvelope } from './parser'

export const http = {
    parse: {
        envelope: parseStandardEnvelope
    }
} as const

export type { StandardEnvelope } from './envelope'

