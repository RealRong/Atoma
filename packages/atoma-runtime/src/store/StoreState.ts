import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreSnapshot, StoreState } from 'atoma-types/runtime'

export class SimpleStoreState<T extends Types.Entity = any> implements StoreState<T> {
    private snapshot: StoreSnapshot<T>
    private listeners = new Set<() => void>()

    constructor(initial?: StoreSnapshot<T>) {
        this.snapshot = initial ?? new Map<EntityId, T>()
    }

    getSnapshot = () => this.snapshot

    setSnapshot = (next: StoreSnapshot<T>) => {
        this.snapshot = next
        this.listeners.forEach(listener => {
            try {
                listener()
            } catch {
                // ignore
            }
        })
    }

    subscribe = (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }
}
