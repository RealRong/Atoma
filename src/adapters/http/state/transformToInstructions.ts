import type { Entity, StoreKey } from '#core'
import type { StateWriteInstruction, StateWriteInput } from './types'

export function transformToInstructions<T extends Entity>(
    input: StateWriteInput<T>,
    deps?: { conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual' }
): StateWriteInstruction<T>[] {
    if (input.source === 'syncChanges') {
        const deleteIds = new Set<StoreKey>()
        let hasUpserts = false

        for (const change of input.changes) {
            const key = normalizeStoreKey(change.entityId as any)
            if (change.kind === 'delete') {
                deleteIds.add(key)
            } else {
                hasUpserts = true
            }
        }

        if (hasUpserts) {
            throw new Error('[StateWriter] syncChanges requires external materialization (use SyncConfig.onPullChanges)')
        }

        if (deleteIds.size) {
            return [{ kind: 'delete', keys: Array.from(deleteIds) }]
        }

        return []
    }

    if (input.source === 'syncAck') {
        const version = input.ack.result.version
        if (typeof version !== 'number' || !Number.isFinite(version)) return []
        const key = normalizeStoreKey(input.ack.result.entityId as any)
        return [{ kind: 'updateVersion', key, version }]
    }

    if (input.source === 'syncReject') {
        const error = input.reject.result.error
        const current = input.reject.result.current
        const strategy = input.conflictStrategy ?? deps?.conflictStrategy ?? 'server-wins'
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            return [{ kind: 'upsert', items: [current.value as T] }]
        }
        return []
    }

    return []
}

function normalizeStoreKey(id: StoreKey): StoreKey {
    if (typeof id === 'string' && /^[0-9]+$/.test(id)) {
        return Number(id)
    }
    return id
}
