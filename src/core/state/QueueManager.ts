import { PrimitiveAtom } from 'jotai'
import { StoreDispatchEvent } from '../types'

/**
 * Manages per-atom dispatch queues; no business logic.
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
        return snapshot
    }

    clear() {
        this.queueMap.clear()
    }
}
