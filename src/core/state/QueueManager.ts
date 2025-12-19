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
        // Patch-based operations（例如 history undo/redo）不参与 coalesce，避免破坏顺序/语义
        if (events.some(e => e.type === 'patches')) {
            return events
        }

        const byKey = new Map<string, StoreDispatchEvent<T>>()

        events.forEach(event => {
            if (event.type === 'patches') return
            const id = event.data.id
            const actionId = event.opContext?.actionId ?? ''
            const key = `${actionId}|${String(id)}`
            const existing = byKey.get(key)

            if (!existing) {
                byKey.set(key, event)
            } else {
                // Merge this event with existing
                byKey.set(key, this.mergeEvents(existing as any, event as any))
            }
        })

        return Array.from(byKey.values())
    }

    /**
     * Merge two events for the same ID
     * Priority: delete > update > add
     */
    private mergeEvents<T extends Entity>(
        prev: Exclude<StoreDispatchEvent<T>, { type: 'patches' }>,
        next: Exclude<StoreDispatchEvent<T>, { type: 'patches' }>
    ): StoreDispatchEvent<T> {
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
