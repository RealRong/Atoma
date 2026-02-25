import { createId } from 'atoma-shared'
import type { StoreChange } from 'atoma-types/core'
import type { SyncDoc } from '../runtime/contracts'
import { isRecord, readVersion } from '../utils/common'

export function toLocalSyncDocs(args: {
    changes: ReadonlyArray<StoreChange<any>>
    resource: string
    clientId: string
    now: () => number
}): SyncDoc[] {
    const docs: SyncDoc[] = []

    for (const change of args.changes) {
        const id = String(change?.id ?? '')
        if (!id) continue

        const after = isRecord(change?.after) ? change.after : undefined
        const before = isRecord(change?.before) ? change.before : undefined

        if (after) {
            docs.push(
                toSyncDoc({
                    source: 'local',
                    resource: args.resource,
                    clientId: args.clientId,
                    id,
                    version: readVersion(after.version) ?? readVersion(before?.version) ?? 1,
                    value: after,
                    now: args.now
                })
            )
            continue
        }

        if (before) {
            docs.push({
                id,
                version: readVersion(before.version) ?? 1,
                _deleted: true,
                atomaSync: {
                    resource: args.resource,
                    source: 'local',
                    clientId: args.clientId,
                    idempotencyKey: createId(),
                    changedAtMs: args.now()
                }
            })
        }
    }

    return docs
}

export function sanitizeIncomingDocument(input: unknown): SyncDoc {
    if (!isRecord(input)) {
        return {
            id: '',
            version: 1,
            _deleted: true
        }
    }

    const id = String(input.id ?? '')
    const version = readVersion(input.version) ?? 1
    const deleted = input._deleted === true

    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        if (key === '_meta' || key === '_rev' || key === '_attachments') continue
        next[key] = value
    }

    return {
        ...next,
        id,
        version,
        _deleted: deleted
    }
}

export function sanitizeOutgoingDocument(input: unknown): SyncDoc {
    return sanitizeIncomingDocument(input)
}

export function toReplicationDocument(input: unknown): SyncDoc & Readonly<{ _deleted: boolean }> {
    const doc = sanitizeIncomingDocument(input)
    return {
        ...doc,
        _deleted: doc._deleted === true
    }
}

export function toEntity(document: SyncDoc): Record<string, unknown> {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(document)) {
        if (key === '_deleted' || key === 'atomaSync') continue
        next[key] = value
    }
    return next
}

function toSyncDoc(args: {
    source: 'local' | 'remote'
    resource: string
    clientId: string
    id: string
    version: number
    value: Record<string, unknown>
    now: () => number
}): SyncDoc {
    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args.value)) {
        if (key === '_meta' || key === '_rev' || key === '_attachments') continue
        cleaned[key] = value
    }

    return {
        ...cleaned,
        id: args.id,
        version: Math.max(1, Math.floor(args.version)),
        _deleted: false,
        atomaSync: {
            resource: args.resource,
            source: args.source,
            clientId: args.clientId,
            idempotencyKey: createId(),
            changedAtMs: args.now()
        }
    }
}
