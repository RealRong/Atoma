import isEqual from 'lodash/isEqual'
import type { Entity } from '../types'
import type { Committer, CommitterCommitArgs, CommitterPrepareArgs, CommitterRollbackArgs } from './types'

export class AtomCommitter implements Committer {
    private mapsEqual(a: Map<any, any>, b: Map<any, any>) {
        if (a === b) return true
        if (a.size !== b.size) return false
        for (const [key, valA] of a.entries()) {
            if (!b.has(key)) return false
            const valB = b.get(key)
            if (!isEqual(valA, valB)) return false
        }
        return true
    }

    private rewriteCreatedInCurrentMap<T extends Entity>(args: {
        store: any
        atom: any
        plan: { operationTypes: any[]; appliedData: T[] }
        created: T[]
    }) {
        const current = args.store.get(args.atom)
        const next = new Map(current)
        let addCursor = 0

        args.plan.operationTypes.forEach((type, idx) => {
            if (type !== 'add') return
            const temp = args.plan.appliedData[idx]
            const serverItem = args.created[addCursor++] ?? temp
            const tempId = (temp as any)?.id
            if (tempId !== undefined) {
                next.delete(tempId)
            }
            const serverId = (serverItem as any)?.id
            if (serverId !== undefined) {
                next.set(serverId, serverItem as any)
            }
            args.plan.appliedData[idx] = serverItem
        })

        return { current, next }
    }

    prepare<T extends Entity>(args: CommitterPrepareArgs<T>) {
        args.store.set(args.atom, args.plan.nextState)
        args.versionTracker.bump(args.atom, args.plan.changedFields)
        args.indexes?.applyPatches(args.originalState, args.plan.nextState, args.plan.patches)
    }

    commit<T extends Entity>(args: CommitterCommitArgs<T>) {
        const activeIndexes = args.indexes ?? null

        if (args.createdResults?.length) {
            const { current, next } = this.rewriteCreatedInCurrentMap({
                store: args.store,
                atom: args.atom,
                plan: args.plan as any,
                created: args.createdResults
            })

            if (!this.mapsEqual(current, next)) {
                args.store.set(args.atom, next)
                args.versionTracker.bump(args.atom, new Set(['id']))
                activeIndexes?.applyMapDiff(current as any, next as any)
            }
        }
    }

    rollback<T extends Entity>(args: CommitterRollbackArgs<T>) {
        args.store.set(args.atom, args.originalState)
        args.indexes?.applyPatches(args.plan.nextState, args.originalState, args.plan.inversePatches)
    }
}
