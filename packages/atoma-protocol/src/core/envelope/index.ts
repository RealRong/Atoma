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

export { parseEnvelope } from './envelope'
