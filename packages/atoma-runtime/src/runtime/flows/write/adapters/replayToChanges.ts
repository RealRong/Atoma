import type { ChangeDirection, Entity, StoreChange } from 'atoma-types/core'

function invertChange<T extends Entity>(change: StoreChange<T>): StoreChange<T> {
    return {
        id: change.id,
        ...(change.after !== undefined ? { before: change.after } : {}),
        ...(change.before !== undefined ? { after: change.before } : {})
    }
}

export function adaptReplayChanges<T extends Entity>(args: {
    changes: ReadonlyArray<StoreChange<T>>
    direction: ChangeDirection
}): StoreChange<T>[] {
    if (args.direction === 'forward') {
        return [...args.changes]
    }

    return [...args.changes]
        .reverse()
        .map(invertChange)
}
