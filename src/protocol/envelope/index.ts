import * as envelopeCompose from './compose'
import * as envelopeParse from './parse'

export const envelope = {
    compose: {
        ok: envelopeCompose.ok,
        error: envelopeCompose.error
    },
    parse: {
        envelope: envelopeParse.parseEnvelope
    }
} as const

export type { EnvelopeOk, EnvelopeErr, Envelope } from './types'
export { parseEnvelope } from './parse'

