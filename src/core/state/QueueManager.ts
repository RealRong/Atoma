import { PrimitiveAtom } from 'jotai/vanilla'
import { StoreDispatchEvent, StoreKey, Entity } from '../types'

/**
 * Manages per-atom dispatch queues with operation coalescing
 */
export class QueueManager {
    private queueMap = new Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]>()

    enqueue(event: StoreDispatchEvent<any>) {
        const existing = this.queueMap.get(event.atom)
        if (existing) {
            existing.push(event)
        } else {
            this.queueMap.set(event.atom, [event])
        }
    }

    flush(): Map<PrimitiveAtom<any>, StoreDispatchEvent<any>[]> {
        const snapshot = new Map(this.queueMap)
        this.queueMap.clear()

        // Coalesce operations per atom
        snapshot.forEach((events, atom) => {
            const coalesced = this.coalesceByID(events)
            snapshot.set(atom, coalesced)
        })

        return snapshot
    }

    clear() {
        this.queueMap.clear()
    }

    /**
     * Coalesce operations by ID to reduce redundant patches
     * Example: add + update + update -> add (with final data)
     *          update + update -> update (with merged data)
     *          any + delete -> delete
     */
    private coalesceByID<T extends Entity>(events: StoreDispatchEvent<T>[]): StoreDispatchEvent<T>[] {
        const byId = new Map<StoreKey, StoreDispatchEvent<T>>()

        events.forEach(event => {
            const id = event.data.id
            const existing = byId.get(id)

            if (!existing) {
                byId.set(id, event)
            } else {
                // Merge this event with existing
                byId.set(id, this.mergeEvents(existing, event))
            }
        })

        return Array.from(byId.values())
    }

    /**
     * Merge two events for the same ID
     * Priority: delete > update > add
     */
    private mergeEvents<T extends Entity>(prev: StoreDispatchEvent<T>, next: StoreDispatchEvent<T>): StoreDispatchEvent<T> {
        // Delete always wins
        if (next.type === 'remove' || next.type === 'forceRemove') {
            return {
                ...next,
                // Keep the earliest onFail for proper error handling
                onFail: prev.onFail || next.onFail
            }
        }

        // If previous was delete, just keep next (shouldn't happen in normal flow)
        if (prev.type === 'remove' || prev.type === 'forceRemove') {
            return next
        }

        // Both are add/update: merge data
        const mergedData = { ...prev.data, ...next.data }

        // Determine final type: if original was 'add', keep it as 'add'
        const finalType = prev.type === 'add' ? 'add' : 'update'

        return {
            ...next,
            type: finalType,
            data: mergedData,
            // Keep the last success callback (most recent intent)
            onSuccess: next.onSuccess,
            // Keep the earliest onFail for proper error handling
            onFail: prev.onFail || next.onFail
        } as StoreDispatchEvent<T>
    }
}
