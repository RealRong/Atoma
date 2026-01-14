import * as envelopeFns from './envelope'

export const envelope = {
    compose: {
        ok: envelopeFns.ok,
        error: envelopeFns.error
    },
    parse: {
        envelope: envelopeFns.parseEnvelope
    }
} as const

export type { EnvelopeOk, EnvelopeErr, Envelope } from './types'
export { parseEnvelope } from './envelope'

