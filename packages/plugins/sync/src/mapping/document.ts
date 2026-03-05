import { createId } from '@atoma-js/shared'
import type { StoreChange } from '@atoma-js/types/core'
import type { SyncDoc } from '../runtime/contracts'
import { isRecord, readVersion } from '../utils/common'

type DocSource = 'local' | 'remote'

export const documentCodec = Object.freeze({
    fromLocalChanges,
    toPushPayload,
    fromPullPayload,
    toRuntimeEntity,
    toTombstone
})

function fromLocalChanges(args: {
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
                toLiveDocument({
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
            docs.push(
                toTombstone({
                    id,
                    version: readVersion(before.version) ?? 1,
                    resource: args.resource,
                    source: 'local',
                    clientId: args.clientId,
                    now: args.now
                })
            )
        }
    }

    return docs
}

function toPushPayload(input: unknown): SyncDoc {
    return normalizeDocument(input)
}

function fromPullPayload(input: unknown): SyncDoc & Readonly<{ _deleted: boolean }> {
    const doc = normalizeDocument(input)
    return {
        ...doc,
        _deleted: doc._deleted === true
    }
}

function toRuntimeEntity(document: SyncDoc): Record<string, unknown> {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(document)) {
        if (key === '_deleted' || key === 'atomaSync') continue
        next[key] = value
    }
    return next
}

function toTombstone(args: {
    id: string
    version: number
    resource: string
    source: DocSource
    clientId: string
    now: () => number
}): SyncDoc {
    return {
        id: args.id,
        version: Math.max(1, Math.floor(args.version)),
        _deleted: true,
        atomaSync: {
            resource: args.resource,
            source: args.source,
            clientId: args.clientId,
            idempotencyKey: createId(),
            changedAtMs: args.now()
        }
    }
}

function normalizeDocument(input: unknown): SyncDoc {
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
        if (isSystemField(key)) continue
        next[key] = value
    }

    return {
        ...next,
        id,
        version,
        _deleted: deleted
    }
}

function toLiveDocument(args: {
    source: DocSource
    resource: string
    clientId: string
    id: string
    version: number
    value: Record<string, unknown>
    now: () => number
}): SyncDoc {
    const cleaned: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args.value)) {
        if (isSystemField(key)) continue
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

function isSystemField(key: string): boolean {
    return key === '_meta'
        || key === '_rev'
        || key === '_attachments'
}
