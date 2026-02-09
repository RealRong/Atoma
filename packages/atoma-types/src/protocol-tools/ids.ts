import { createId } from 'atoma-shared'

const IDEMPOTENCY_PREFIX = 'i'

export function createIdempotencyKey(args?: { now?: () => number }): string {
    return createId({
        kind: 'request',
        sortable: true,
        prefix: IDEMPOTENCY_PREFIX,
        now: args?.now
    })
}

export function createOpId(prefix: string, args?: { now?: () => number }): string {
    const normalizedPrefix = (typeof prefix === 'string' && prefix) ? prefix : 'op'
    return createId({
        kind: 'action',
        sortable: true,
        prefix: normalizedPrefix,
        now: args?.now
    })
}
