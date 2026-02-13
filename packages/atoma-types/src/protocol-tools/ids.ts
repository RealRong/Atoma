import { createId, createIdempotencyKey as createSharedIdempotencyKey } from 'atoma-shared'

export function createIdempotencyKey(args?: { now?: () => number }): string {
    return createSharedIdempotencyKey(args)
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
