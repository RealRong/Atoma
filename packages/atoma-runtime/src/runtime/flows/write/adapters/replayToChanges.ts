import type { ChangeDirection, Entity, StoreChange } from 'atoma-types/core'

function invertChange<T extends Entity>(change: StoreChange<T>): StoreChange<T> {
    if (change.before !== undefined && change.after !== undefined) {
        return {
            id: change.id,
            before: change.after,
            after: change.before
        }
    }
    if (change.after !== undefined) {
        return {
            id: change.id,
            before: change.after
        }
    }
    if (change.before !== undefined) {
        return {
            id: change.id,
            after: change.before
        }
    }

    throw new Error(`[Atoma] replay change missing before/after (id=${String(change.id)})`)
}

export function adaptReplayChanges<T extends Entity>(
    changes: ReadonlyArray<StoreChange<T>>,
    direction: ChangeDirection
): StoreChange<T>[] {
    if (direction === 'forward') {
        return [...changes]
    }

    return [...changes]
        .reverse()
        .map(invertChange)
}
