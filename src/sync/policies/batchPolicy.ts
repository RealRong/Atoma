import type { SyncOutboxItem } from '../types'
import type { WriteAction, WriteItem } from '#protocol'

export type WriteBatch = {
    resource: string
    action: WriteAction
    items: WriteItem[]
    entries: SyncOutboxItem[]
}

export function buildWriteBatch(pending: SyncOutboxItem[]): WriteBatch | undefined {
    if (!pending.length) return undefined

    const first = pending[0]
    const entries: SyncOutboxItem[] = []
    for (const item of pending) {
        if (item.resource !== first.resource || item.action !== first.action) break
        entries.push(item)
    }

    return {
        resource: first.resource,
        action: first.action,
        items: entries.map(item => item.item),
        entries
    }
}
