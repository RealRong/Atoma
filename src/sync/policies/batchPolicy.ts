import type { SyncOutboxItem } from '../types'
import type { WriteAction, WriteItem, WriteOptions } from '#protocol'

export type WriteBatch = {
    resource: string
    action: WriteAction
    items: WriteItem[]
    entries: SyncOutboxItem[]
    options?: WriteOptions
}

function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value)
    if (typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`
}

function optionsKey(options: WriteOptions | undefined): string {
    if (!options) return ''
    return stableStringify(options)
}

export function buildWriteBatch(pending: SyncOutboxItem[]): WriteBatch | undefined {
    if (!pending.length) return undefined

    const first = pending[0]
    const firstOptionsKey = optionsKey(first.options as any)
    const entries: SyncOutboxItem[] = []
    for (const item of pending) {
        if (item.resource !== first.resource || item.action !== first.action) break
        if (optionsKey(item.options as any) !== firstOptionsKey) break
        entries.push(item)
    }

    return {
        resource: first.resource,
        action: first.action,
        items: entries.map(item => item.item),
        entries,
        ...(first.options ? { options: first.options as any } : {})
    }
}
