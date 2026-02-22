import type { Entity, StoreToken } from 'atoma-types/core'
import type {
    Runtime,
    Debug as DebugType,
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

export class Debug implements DebugType {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    readonly snapshotStore: DebugType['snapshotStore'] = (storeName: StoreToken) => {
        const name = String(storeName)

        try {
            const inspected = this.runtime.stores.inspect(name).snapshot
            const sample = Array.from(inspected.values()).slice(0, 5)

            return {
                name,
                count: inspected.size,
                approxSize: estimateSampleSize(sample),
                sample,
                timestamp: this.runtime.now()
            }
        } catch {
            return undefined
        }
    }

    readonly snapshotIndexes: DebugType['snapshotIndexes'] = <T extends Entity = Entity>(storeName: StoreToken) => {
        const name = String(storeName)

        try {
            const indexes = this.runtime.stores.inspect<T>(name).indexes as IndexDebugLike<T> | null
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
                timestamp: this.runtime.now()
            }
        } catch {
            return undefined
        }
    }
}
