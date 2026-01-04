import type { SyncOutboxItem } from '../types'
import type { WriteAction, WriteItem, WriteOptions } from '#protocol'

export type WriteBatch = {
    resource: string
    action: WriteAction
    items: WriteItem[]
    entries: SyncOutboxItem[]
    /**
     * 每个 batch item 代表的 outbox entries（用于 compaction：一个请求 item 可覆盖多个 outbox items）
     */
    representedEntries?: SyncOutboxItem[][]
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
    return buildWriteBatchCompacted(pending)
}

export function buildWriteBatchCompacted(
    pending: SyncOutboxItem[],
    maxSendItems?: number
): WriteBatch | undefined {
    if (!pending.length) return undefined

    const first = pending[0]
    const firstOptionsKey = optionsKey(first.options as any)
    const entries: SyncOutboxItem[] = []
    for (const item of pending) {
        if (item.resource !== first.resource || item.action !== first.action) break
        if (optionsKey(item.options as any) !== firstOptionsKey) break
        entries.push(item)
    }

    const limit = (typeof maxSendItems === 'number' && Number.isFinite(maxSendItems))
        ? Math.max(1, Math.floor(maxSendItems))
        : Number.POSITIVE_INFINITY

    const byEntityId = new Map<string, SyncOutboxItem[]>()
    const unknownEntityItems: SyncOutboxItem[] = []
    for (const e of entries) {
        const entityId = (e.item as any)?.entityId
        if (typeof entityId !== 'string' || !entityId) {
            unknownEntityItems.push(e)
            continue
        }
        const list = byEntityId.get(entityId)
        if (list) list.push(e)
        else byEntityId.set(entityId, [e])
    }

    const lastIndexByEntityId = new Map<string, number>()
    byEntityId.forEach((list, entityId) => {
        const last = list[list.length - 1]
        const idx = entries.indexOf(last)
        lastIndexByEntityId.set(entityId, idx)
    })

    const entityIdsSorted = Array.from(lastIndexByEntityId.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([entityId]) => entityId)

    const selectedEntityIds = entityIdsSorted.slice(0, limit)

    const compactedEntries: SyncOutboxItem[] = []
    const compactedItems: WriteItem[] = []
    const representedEntries: SyncOutboxItem[][] = []

    for (const entityId of selectedEntityIds) {
        const list = byEntityId.get(entityId)
        if (!list || !list.length) continue
        const primary = list[list.length - 1]

        const sendItem: any = primary.item && typeof primary.item === 'object' && !Array.isArray(primary.item)
            ? { ...(primary.item as any) }
            : primary.item

        // virtual baseVersion：对需要 baseVersion 的写入，用“最后一个 outbox item 的 baseVersion”为准
        const lastBaseVersion = (primary.item as any)?.baseVersion
        if (typeof lastBaseVersion === 'number' && Number.isFinite(lastBaseVersion) && lastBaseVersion > 0) {
            sendItem.baseVersion = lastBaseVersion
        }

        compactedEntries.push(primary)
        compactedItems.push(sendItem as WriteItem)
        representedEntries.push(list.slice())
    }

    // entityId 缺失时不做 compaction（极端兜底）
    for (const e of unknownEntityItems) {
        if (compactedEntries.length >= limit) break
        compactedEntries.push(e)
        compactedItems.push(e.item)
        representedEntries.push([e])
    }

    return {
        resource: first.resource,
        action: first.action,
        items: compactedItems,
        entries: compactedEntries,
        representedEntries,
        ...(first.options ? { options: first.options as any } : {})
    }
}
