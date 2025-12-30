import type { Entity } from '../types'
import { preserveReferenceShallow } from '../store/preserveReference'
import type { Committer, CommitterCommitArgs, CommitterPrepareArgs, CommitterRollbackArgs } from './types'

export class AtomCommitter implements Committer {
    private rewriteCreatedInCurrentMap<T extends Entity>(args: {
        store: any
        atom: any
        plan: { operationTypes: any[]; appliedData: T[] }
        created: T[]
    }) {
        const current = args.store.get(args.atom)
        let next: Map<any, any> | null = null
        let changed = false
        const changedIds = new Set<any>()
        let addCursor = 0

        args.plan.operationTypes.forEach((type, idx) => {
            if (type !== 'add') return
            const temp = args.plan.appliedData[idx]
            const serverItem = args.created[addCursor++] ?? temp
            const tempId = (temp as any)?.id
            const serverId = (serverItem as any)?.id

            if (tempId !== undefined && tempId !== serverId && current.has(tempId)) {
                if (!next) next = new Map(current)
                next.delete(tempId)
                changed = true
                changedIds.add(tempId)
            }

            if (serverId !== undefined) {
                const existing = current.get(serverId)
                const value = preserveReferenceShallow(existing, serverItem)
                const existed = current.has(serverId)
                if (!existed || existing !== value) {
                    if (!next) next = new Map(current)
                    next.set(serverId, value as any)
                    changed = true
                    changedIds.add(serverId)
                }
            }
            args.plan.appliedData[idx] = serverItem
        })

        return { current, next: next ?? current, changed, changedIds }
    }

    prepare<T extends Entity>(args: CommitterPrepareArgs<T>) {
        args.store.set(args.atom, args.plan.nextState)
        args.indexes?.applyPatches(args.originalState, args.plan.nextState, args.plan.patches)
    }

    commit<T extends Entity>(args: CommitterCommitArgs<T>) {
        const activeIndexes = args.indexes ?? null

        if (args.createdResults?.length) {
            const { current, next, changed, changedIds } = this.rewriteCreatedInCurrentMap({
                store: args.store,
                atom: args.atom,
                plan: args.plan as any,
                created: args.createdResults
            })

            if (changed) {
                args.store.set(args.atom, next)
                activeIndexes?.applyChangedIds(current as any, next as any, changedIds)
            }
        }
    }

    rollback<T extends Entity>(args: CommitterRollbackArgs<T>) {
        args.store.set(args.atom, args.originalState)
        args.indexes?.applyPatches(args.plan.nextState, args.originalState, args.plan.inversePatches)
    }
}
