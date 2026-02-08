import type { Patch } from 'immer'
import type { EntityId } from 'atoma-types/protocol'

type UpdateHandler<T> = {
    add: (item: T) => void
    remove: (item?: T) => void
}

export class IndexDeltaUpdater {
    static applyPatches<T>(args: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        patches: Patch[]
        handler: UpdateHandler<T>
    }) {
        const changedIds = new Set<EntityId>()

        args.patches.forEach(patch => {
            const path = patch.path
            if (!Array.isArray(path) || path.length < 1) return
            changedIds.add(path[0] as EntityId)
        })

        changedIds.forEach(id => {
            const prev = args.before.get(id)
            const next = args.after.get(id)
            if (prev) args.handler.remove(prev)
            if (next) args.handler.add(next)
        })
    }

    static applyChangedIds<T>(args: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds: Iterable<EntityId>
        handler: UpdateHandler<T>
    }) {
        for (const id of args.changedIds) {
            const prev = args.before.get(id)
            const next = args.after.get(id)
            if (prev === next) continue
            if (prev) args.handler.remove(prev)
            if (next) args.handler.add(next)
        }
    }

    static applyMapDiff<T>(args: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        handler: UpdateHandler<T>
    }) {
        args.before.forEach((prevItem, id) => {
            const nextItem = args.after.get(id)
            if (!nextItem) {
                args.handler.remove(prevItem)
                return
            }

            if (nextItem !== prevItem) {
                args.handler.remove(prevItem)
                args.handler.add(nextItem)
            }
        })

        args.after.forEach((nextItem, id) => {
            if (!args.before.has(id)) {
                args.handler.add(nextItem)
            }
        })
    }
}
