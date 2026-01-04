import type { Entity } from '../types'
import { preserveReferenceShallow } from '../store/internals/preserveReference'
import type { Committer, CommitterCommitArgs, CommitterPrepareArgs, CommitterRollbackArgs } from './types'

export class AtomCommitter implements Committer {
    private rewriteCreatedInCurrentMap<T extends Entity>(args: {
        store: any
        atom: any
        plan: { operationTypes: any[]; appliedData: any[] }
        created: T[]
    }) {
        const current = args.store.get(args.atom)
        let next: Map<any, any> | null = null
        let changed = false
        const changedIds = new Set<any>()
        let addCursor = 0

        args.plan.operationTypes.forEach((type, idx) => {
            if (type !== 'add' && type !== 'create') return
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
        if (args.plan.patches.length === 0 && args.plan.nextState === args.originalState) return
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

        const versionUpdates = args.writeback?.versionUpdates ?? []
        if (!versionUpdates.length) return

        const versionByKey = new Map<any, number>()
        for (const v of versionUpdates) {
            if (!v) continue
            versionByKey.set((v as any).key, (v as any).version)
        }
        if (!versionByKey.size) return

        if (Array.isArray((args.plan as any)?.appliedData) && Array.isArray((args.plan as any)?.operationTypes)) {
            const appliedData = (args.plan as any).appliedData as any[]
            const operationTypes = (args.plan as any).operationTypes as any[]
            operationTypes.forEach((type, idx) => {
                if (type !== 'add' && type !== 'create' && type !== 'update' && type !== 'upsert') return
                const cur = appliedData[idx]
                const id = cur && typeof cur === 'object' ? (cur as any).id : undefined
                if (id === undefined) return
                const version = versionByKey.get(id)
                if (typeof version !== 'number' || !Number.isFinite(version) || version <= 0) return
                if (cur && typeof cur === 'object' && (cur as any).version === version) return
                appliedData[idx] = preserveReferenceShallow(cur, { ...(cur as any), version } as any)
            })
        }

        const current = args.store.get(args.atom)
        let next: Map<any, any> | null = null
        const changedIds = new Set<any>()

        const ensureNext = () => {
            if (!next) next = new Map(current)
            return next
        }

        for (const [key, version] of versionByKey.entries()) {
            if (typeof version !== 'number' || !Number.isFinite(version) || version <= 0) continue
            const cur = (current as any).get(key)
            if (!cur || typeof cur !== 'object') continue
            if ((cur as any).version === version) continue
            ensureNext().set(key, preserveReferenceShallow(cur, { ...(cur as any), version } as any))
            changedIds.add(key)
        }

        if (!changedIds.size || !next) return
        args.store.set(args.atom, next)
        activeIndexes?.applyChangedIds(current as any, next as any, changedIds)
    }

    rollback<T extends Entity>(args: CommitterRollbackArgs<T>) {
        args.store.set(args.atom, args.originalState)
        args.indexes?.applyPatches(args.plan.nextState, args.originalState, args.plan.inversePatches)
    }
}
