import { createId } from '@atoma-js/shared'

export function createOpId(prefix: string, args?: { now?: () => number }): string {
    const normalizedPrefix = (typeof prefix === 'string' && prefix) ? prefix : 'op'
    return createId({
        kind: 'action',
        sortable: true,
        prefix: normalizedPrefix,
        now: args?.now
    })
}
