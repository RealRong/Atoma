import type { WriteCoordinator } from 'atoma-types/client/ops'
import type { PluginRuntime } from 'atoma-types/client/plugins'
import type { StoreToken } from 'atoma-types/core'
import type { Version, WriteEntry as ProtocolWriteEntry, WriteItemMeta } from 'atoma-types/protocol'
import type { WriteEntry as RuntimeWriteEntry } from 'atoma-types/runtime'

function readPositiveVersion(value: unknown): Version | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined
}

function readSnapshotVersion(args: {
    runtime: PluginRuntime
    storeName: StoreToken
    id: string
}): Version | undefined {
    const { runtime, storeName, id } = args
    const current = runtime.stores.peek(storeName, id)
    const version = (current as { version?: unknown } | undefined)?.version
    return readPositiveVersion(version)
}

function requireWriteMeta(args: {
    action: RuntimeWriteEntry['action']
    storeName: StoreToken
    id: unknown
    meta: unknown
}): WriteItemMeta {
    const { action, storeName, id, meta } = args
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        throw new Error(`[Atoma] write(${action}) requires item.meta (store=${storeName}, id=${String(id)})`)
    }
    const idempotencyKey = (meta as { idempotencyKey?: unknown }).idempotencyKey
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
        throw new Error(`[Atoma] write(${action}) requires item.meta.idempotencyKey (store=${storeName}, id=${String(id)})`)
    }
    const clientTimeMs = (meta as { clientTimeMs?: unknown }).clientTimeMs
    if (typeof clientTimeMs !== 'number' || !Number.isFinite(clientTimeMs)) {
        throw new Error(`[Atoma] write(${action}) requires item.meta.clientTimeMs (store=${storeName}, id=${String(id)})`)
    }
    return meta as WriteItemMeta
}

function encodeWriteEntry(args: {
    runtime: PluginRuntime
    storeName: StoreToken
    entry: RuntimeWriteEntry
}): ProtocolWriteEntry {
    const { runtime, storeName, entry } = args
    const meta = requireWriteMeta({
        action: entry.action,
        storeName,
        id: (entry.item as { id?: unknown }).id,
        meta: (entry.item as { meta?: unknown }).meta
    })

    switch (entry.action) {
        case 'create':
            return {
                ...entry,
                item: {
                    ...entry.item,
                    meta
                }
            }
        case 'update': {
            const baseVersion = readSnapshotVersion({
                runtime,
                storeName,
                id: entry.item.id
            })
            if (typeof baseVersion !== 'number') {
                throw new Error(`[Atoma] write(update) requires baseVersion (store=${storeName}, id=${entry.item.id})`)
            }
            return {
                ...entry,
                item: {
                    ...entry.item,
                    baseVersion,
                    meta
                }
            }
        }
        case 'delete': {
            const baseVersion = readSnapshotVersion({
                runtime,
                storeName,
                id: entry.item.id
            })
            if (typeof baseVersion !== 'number') {
                throw new Error(`[Atoma] write(delete) requires baseVersion (store=${storeName}, id=${entry.item.id})`)
            }
            return {
                ...entry,
                item: {
                    ...entry.item,
                    baseVersion,
                    meta
                }
            }
        }
        case 'upsert': {
            const conflict = entry.options?.upsert?.conflict ?? 'cas'
            if (conflict !== 'cas') {
                return {
                    ...entry,
                    item: {
                        ...entry.item,
                        meta
                    }
                }
            }

            const expectedVersion = readSnapshotVersion({
                runtime,
                storeName,
                id: entry.item.id
            })
            return {
                ...entry,
                item: {
                    ...entry.item,
                    meta,
                    ...(typeof expectedVersion === 'number'
                        ? { expectedVersion }
                        : {})
                }
            }
        }
    }
}

export function createWriteCoordinator(runtime: PluginRuntime): WriteCoordinator {
    return {
        encode: ({ storeName, entries }) => {
            return entries.map((entry) => encodeWriteEntry({
                runtime,
                storeName,
                entry
            }))
        }
    }
}
