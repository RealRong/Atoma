import type { Entity } from 'atoma-types/core'
import type { PreparedWrite } from './contracts'

export function resolvePreparedOutput<T extends Entity>(
    item: PreparedWrite<T>,
    index: number
): T | void {
    if (item.entry.action === 'delete') {
        return
    }

    if (item.output === undefined) {
        throw new Error(`[Atoma] write: missing prepared output at index=${index}`)
    }

    return item.output
}
