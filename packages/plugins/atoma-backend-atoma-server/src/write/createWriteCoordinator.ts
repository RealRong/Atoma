import type { WriteCoordinator } from 'atoma-types/client/ops'
import type { PluginRuntime } from 'atoma-types/client/plugins'
import type { StoreToken } from 'atoma-types/core'
import type { Version, WriteEntry as ProtocolWriteEntry } from 'atoma-types/protocol'
import type { WriteEntry as RuntimeWriteEntry } from 'atoma-types/runtime'

function resolvePositiveVersion(value: unknown): Version | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined
}

function resolveSnapshotVersion(args: {
    runtime: PluginRuntime
    storeName: StoreToken
    id: string
}): Version | undefined {
    const { runtime, storeName, id } = args
    const current = runtime.stores.peek(storeName, id)
    const version = (current as { version?: unknown } | undefined)?.version
    return resolvePositiveVersion(version)
}

function encodeWriteEntry(args: {
    runtime: PluginRuntime
    storeName: StoreToken
    entry: RuntimeWriteEntry
}): ProtocolWriteEntry {
    const { runtime, storeName, entry } = args

    switch (entry.action) {
        case 'create':
            return entry
        case 'update': {
            const baseVersion = resolveSnapshotVersion({
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
                    baseVersion
                }
            }
        }
        case 'delete': {
            const baseVersion = resolveSnapshotVersion({
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
                    baseVersion
                }
            }
        }
        case 'upsert': {
            const conflict = entry.options?.upsert?.conflict ?? 'cas'
            if (conflict !== 'cas') return entry

            const expectedVersion = resolveSnapshotVersion({
                runtime,
                storeName,
                id: entry.item.id
            })
            return {
                ...entry,
                item: {
                    ...entry.item,
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
