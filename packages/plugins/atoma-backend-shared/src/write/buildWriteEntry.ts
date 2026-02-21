import type { Entity } from 'atoma-types/core'
import type { StoreHandle, WriteEntry as RuntimeWriteEntry } from 'atoma-types/runtime'
import type { Version, WriteEntry as ProtocolWriteEntry } from 'atoma-types/protocol'

function resolvePositiveVersion(value: unknown): Version | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined
}

function resolveSnapshotVersion<T extends Entity>(
    handle: StoreHandle<T>,
    id: string
): Version | undefined {
    const current = handle.state.snapshot().get(id)
    const version = (current as { version?: unknown } | undefined)?.version
    return resolvePositiveVersion(version)
}

function requireBaseVersion<T extends Entity>({
    handle,
    id,
    action,
    value
}: {
    handle: StoreHandle<T>
    id: string
    action: 'update' | 'delete'
    value: unknown
}): Version {
    const explicit = resolvePositiveVersion(value)
    if (typeof explicit === 'number') return explicit

    const fallback = resolveSnapshotVersion(handle, id)
    if (typeof fallback === 'number') return fallback

    throw new Error(`[Atoma] write(${action}) requires baseVersion (id=${id})`)
}

export function buildWriteEntry<T extends Entity>({
    handle,
    entry
}: {
    handle: StoreHandle<T>
    entry: RuntimeWriteEntry
}): ProtocolWriteEntry {
    switch (entry.action) {
        case 'create':
            return entry
        case 'update': {
            const id = entry.item.id
            const baseVersion = requireBaseVersion({
                handle,
                id,
                action: 'update',
                value: entry.item.baseVersion
            })
            return {
                ...entry,
                item: {
                    ...entry.item,
                    baseVersion
                }
            }
        }
        case 'delete': {
            const id = entry.item.id
            const baseVersion = requireBaseVersion({
                handle,
                id,
                action: 'delete',
                value: entry.item.baseVersion
            })
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
            const expectedVersion = resolvePositiveVersion(entry.item.expectedVersion)

            if (conflict !== 'cas') {
                return {
                    ...entry,
                    item: {
                        ...entry.item,
                        ...(typeof expectedVersion === 'number' ? { expectedVersion } : {})
                    }
                }
            }

            const fallbackVersion = resolveSnapshotVersion(handle, entry.item.id)
            return {
                ...entry,
                item: {
                    ...entry.item,
                    ...(typeof (expectedVersion ?? fallbackVersion) === 'number'
                        ? { expectedVersion: expectedVersion ?? fallbackVersion }
                        : {})
                }
            }
        }
    }
}

export function buildWriteEntries<T extends Entity>({
    handle,
    entries
}: {
    handle: StoreHandle<T>
    entries: ReadonlyArray<RuntimeWriteEntry>
}): ProtocolWriteEntry[] {
    return entries.map((entry) => buildWriteEntry({
        handle,
        entry
    }))
}
