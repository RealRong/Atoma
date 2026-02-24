import type {
    Entity,
    StoreChange
} from 'atoma-types/core'
import type { WriteEntry } from 'atoma-types/runtime'
import type { IntentCommand } from '../contracts'
import type { Row } from '../context'

export function toIntentId<T extends Entity>(intent: IntentCommand<T>): string | undefined {
    if (intent.action === 'create') {
        const maybeId = (intent.item as { id?: unknown }).id
        return typeof maybeId === 'string' && maybeId.length > 0 ? maybeId : undefined
    }
    if (intent.action === 'upsert') {
        return String(intent.item.id)
    }
    return String(intent.id)
}

export function ensureEntry<T extends Entity>(row: Row<T>, index: number): WriteEntry {
    if (!row.entry) {
        throw new Error(`[Atoma] write: missing write entry at index=${index}`)
    }
    return row.entry
}

export function ensureChange<T extends Entity>(row: Row<T>, index: number): StoreChange<T> {
    if (!row.change) {
        throw new Error(`[Atoma] write: missing change at index=${index}`)
    }
    return row.change
}

export function ensureOutput<T extends Entity>(row: Row<T>, index: number): T | void {
    if (row.intent.action === 'delete') return
    const change = ensureChange(row, index)
    if (change.after === undefined) {
        throw new Error(`[Atoma] write: missing output at index=${index}`)
    }
    return change.after
}
