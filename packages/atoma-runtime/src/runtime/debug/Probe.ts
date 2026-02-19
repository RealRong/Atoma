import type { Entity, StoreToken } from 'atoma-types/core'
import type {
    Runtime,
    Debug,
    IndexDebugSnapshot,
} from 'atoma-types/runtime'

type IndexDebugLike<T extends Entity = Entity> = {
    debugIndexSnapshots?: () => IndexDebugSnapshot<T>['indexes']
    debugLastQueryPlan?: () => unknown
}

function estimateSampleSize(sample: unknown[]): number {
    try {
        const text = JSON.stringify(sample)
        return text ? text.length * 2 : 0
    } catch {
        return 0
    }
}

export class Probe implements Debug {
    private readonly stores: Runtime['stores']
    private readonly now: () => number

    constructor({
        stores,
        now
    }: {
        stores: Runtime['stores']
        now: () => number
    }) {
        this.stores = stores
        this.now = now
    }

    readonly snapshotStore: Debug['snapshotStore'] = (storeName: StoreToken) => {
        const name = String(storeName)

        try {
            const handle = this.stores.ensureHandle(name, `runtime.debug.snapshotStore:${name}`)
            const map = handle.state.getSnapshot() as Map<unknown, unknown>
            const sample = Array.from(map.values()).slice(0, 5)

            return {
                name,
                count: map.size,
                approxSize: estimateSampleSize(sample),
                sample,
                timestamp: this.now()
            }
        } catch {
            return undefined
        }
    }

    readonly snapshotIndexes: Debug['snapshotIndexes'] = <T extends Entity = Entity>(storeName: StoreToken) => {
        const name = String(storeName)

        try {
            const handle = this.stores.ensureHandle(name, `runtime.debug.snapshotIndexes:${name}`)
            const indexes = handle.state.indexes as IndexDebugLike<T> | null

            if (!indexes || typeof indexes.debugIndexSnapshots !== 'function') {
                return undefined
            }

            const snapshots = indexes.debugIndexSnapshots()
            const lastQuery = typeof indexes.debugLastQueryPlan === 'function'
                ? indexes.debugLastQueryPlan()
                : undefined

            return {
                name,
                indexes: snapshots,
                ...(lastQuery ? { lastQuery } : {}),
                timestamp: this.now()
            }
        } catch {
            return undefined
        }
    }
}
