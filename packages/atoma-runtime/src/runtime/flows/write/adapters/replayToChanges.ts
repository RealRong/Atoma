import type { ChangeDirection, Entity, StoreChange } from 'atoma-types/core'
import { invertChanges } from 'atoma-core/store'

export function adaptReplayChanges<T extends Entity>(
    changes: ReadonlyArray<StoreChange<T>>,
    direction: ChangeDirection
): StoreChange<T>[] {
    if (direction === 'forward') {
        return [...changes]
    }

    return invertChanges([...changes].reverse())
}
