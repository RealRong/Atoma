import { Reducer } from './Reducer'
import type { EntityId } from '#protocol'
import type { Entity, PatchMetadata, StoreDispatchEvent } from '../../types'
import {
    type IExecutor,
    type ExecutorRunArgs,
    type Plan,
    type PersisterPersistResult,
    type Planner
} from './types'
import type { Committer } from '../types'
import { AtomCommitter } from '../AtomCommitter'
import { DirectPersister } from './persisters/Direct'
import { OutboxPersister } from './persisters/Outbox'
import type { BeforePersistContext, CommittedEvent, PersistResult, RolledBackEvent } from '../hooks'

class DefaultPlanner implements Planner {
    private readonly reducer = new Reducer()

    plan<T extends Entity>(
        operations: StoreDispatchEvent<T>[],
        currentState: Map<EntityId, T>
    ): Plan<T> {
        const atom = operations[0]?.handle.atom as any

        let baseState: Map<EntityId, T> = currentState
        const hydrateChangedIds = new Set<EntityId>()

        const writeOps: Array<StoreDispatchEvent<T>> = []

        for (const op of operations) {
            if (op.type === 'hydrate') {
                const item = (op as any).data as any
                const id = item?.id as EntityId | undefined
                if (id !== undefined && id !== null && !baseState.has(id)) {
                    if (baseState === currentState) {
                        const next = new Map(currentState)
                        next.set(id, item as any)
                        baseState = next as any
                    } else {
                        (baseState as any).set(id, item as any)
                    }
                    hydrateChangedIds.add(id)
                }
                continue
            }
            if (op.type === 'hydrateMany') {
                const items = ((op as any).items as any[]) ?? []
                for (const item of items) {
                    const id = item?.id as EntityId | undefined
                    if (id === undefined || id === null) continue
                    if (baseState.has(id)) continue
                    if (baseState === currentState) {
                        const next = new Map(currentState)
                        next.set(id, item as any)
                        baseState = next as any
                    } else {
                        (baseState as any).set(id, item as any)
                    }
                    hydrateChangedIds.add(id)
                }
                continue
            }

            writeOps.push(op)
        }

        const baseStateForPlan = baseState === currentState ? undefined : baseState

        if (writeOps.length === 0) {
            const operationTypes = operations.map(o => o.type as any)
            const appliedData = operations.map(o => {
                if (o.type === 'hydrate') return (o as any).data
                if (o.type === 'hydrateMany') return (o as any).items
                return (o as any).data
            })

            return {
                ...(baseStateForPlan ? { baseState: baseStateForPlan } : {}),
                ...(hydrateChangedIds.size ? { changedIdsForIndexes: hydrateChangedIds } : {}),
                nextState: baseState,
                patches: [],
                inversePatches: [],
                changedFields: new Set(),
                appliedData,
                operationTypes,
                atom
            } as any
        }

        const writePlan = this.reducer.reduce(writeOps, baseState)

        const appliedData = new Array<any>(operations.length)
        const operationTypes = new Array<any>(operations.length)

        let writeCursor = 0
        for (let i = 0; i < operations.length; i++) {
            const op = operations[i]
            if (op.type === 'hydrate') {
                operationTypes[i] = 'hydrate'
                appliedData[i] = (op as any).data
                continue
            }
            if (op.type === 'hydrateMany') {
                operationTypes[i] = 'hydrateMany'
                appliedData[i] = (op as any).items
                continue
            }

            operationTypes[i] = writePlan.operationTypes[writeCursor]
            appliedData[i] = writePlan.appliedData[writeCursor]
            writeCursor++
        }

        const changedIdsForIndexes = new Set<EntityId>()
        hydrateChangedIds.forEach(id => changedIdsForIndexes.add(id))
        writePlan.patches.forEach(p => {
            const path = (p as any)?.path
            if (!Array.isArray(path) || path.length < 1) return
            const id = path[0] as any as EntityId
            if (id === undefined || id === null) return
            changedIdsForIndexes.add(id)
        })

        return {
            ...(baseStateForPlan ? { baseState: baseStateForPlan } : {}),
            ...(changedIdsForIndexes.size ? { changedIdsForIndexes } : {}),
            ...writePlan,
            appliedData,
            operationTypes,
            atom
        } as any
    }
}

export class Executor implements IExecutor {
    planner: Planner
    committer: Committer
    private readonly directPersister = new DirectPersister()

    constructor() {
        this.planner = new DefaultPlanner()
        this.committer = new AtomCommitter()
    }

    async run<T extends Entity>(args: ExecutorRunArgs<T>) {
        const { handle, operations, plan, atom, store, indexes } = args
        const ctx = args.observabilityContext
        const traceId = ctx.traceId
        const mutationHooks = handle.services.mutation.hooks
        const storeName = args.storeName ?? handle.storeName

        const originalState = store.get(atom)

        const clientTimeMs = operations.find(op => typeof op.ticket?.clientTimeMs === 'number')?.ticket?.clientTimeMs

        const metadata: PatchMetadata = {
            atom,
            databaseName: handle.backend.key,
            timestamp: typeof clientTimeMs === 'number' ? clientTimeMs : Date.now(),
            baseVersion: Date.now(),
            traceId
        }

        ctx.emit('mutation:patches', {
            patchCount: plan.patches.length,
            inversePatchCount: plan.inversePatches.length,
            changedFields: plan.changedFields instanceof Set ? Array.from(plan.changedFields) : undefined
        })

        this.committer.prepare({
            atom,
            store,
            plan,
            originalState,
            indexes
        })

        const persistCtx: BeforePersistContext<T> = {
            storeName,
            opContext: args.opContext,
            handle,
            operations: operations as any,
            plan: plan as any,
            metadata,
            observabilityContext: ctx
        }

        try {
            const resolvePersistMode = () => {
                const set = new Set<'direct' | 'outbox'>()
                for (const op of operations) {
                    const m = (op as any)?.persist
                    if (m === 'outbox' || m === 'direct') set.add(m)
                }
                if (set.size === 0) return 'direct' as const
                if (set.size === 1) return Array.from(set)[0] as 'direct' | 'outbox'
                throw new Error('[Atoma] mixed persist modes in one mutation segment (direct vs outbox)')
            }

            const persistDirect = async (): Promise<PersistResult<T>> => {
                const res: PersisterPersistResult<T> = await this.directPersister.persist({
                    handle: persistCtx.handle,
                    operations: persistCtx.operations,
                    plan: persistCtx.plan,
                    metadata: persistCtx.metadata,
                    observabilityContext: persistCtx.observabilityContext
                })

                const createdResults = (res && typeof res === 'object' && Array.isArray((res as any).created))
                    ? ((res as any).created as T[])
                    : undefined
                const writeback = (res && typeof res === 'object' && (res as any).writeback && typeof (res as any).writeback === 'object')
                    ? ((res as any).writeback as any)
                    : undefined

                return {
                    mode: 'direct',
                    status: 'confirmed',
                    ...(createdResults ? { created: createdResults } : {}),
                    ...(writeback ? { writeback } : {})
                }
            }

            const persistOutbox = async (): Promise<PersistResult<T>> => {
                const outbox = handle.services.outbox
                if (!outbox) {
                    throw new Error('[Atoma] outbox persist requested but runtime.outbox is not configured (sync not installed)')
                }

                const queueMode = outbox.queueMode === 'local-first' ? 'local-first' : 'queue'

                let localPersist: PersistResult<T> | undefined
                if (queueMode === 'local-first') {
                    localPersist = await persistDirect()
                }

                const enqueuer = outbox.ensureEnqueuer()
                const persister = new OutboxPersister(enqueuer)
                await persister.persist({
                    handle: persistCtx.handle,
                    operations: persistCtx.operations,
                    plan: persistCtx.plan,
                    metadata: persistCtx.metadata,
                    observabilityContext: persistCtx.observabilityContext
                })

                return {
                    mode: 'outbox',
                    status: 'enqueued',
                    ...(localPersist?.created ? { created: localPersist.created } : {}),
                    ...(localPersist?.writeback ? { writeback: localPersist.writeback } : {})
                }
            }

            const persistMode = resolvePersistMode()
            const persistResult = await (persistMode === 'direct'
                ? persistDirect()
                : persistOutbox())

            await mutationHooks.events.afterPersist.emit({ ctx: persistCtx, result: persistResult })

            const createdResults = persistResult.created
            const writeback = persistResult.writeback

            this.committer.commit({
                atom,
                store,
                plan,
                createdResults,
                writeback,
                indexes
            })

            const committedEvent: CommittedEvent<T> = {
                storeName: persistCtx.storeName,
                opContext: persistCtx.opContext,
                handle,
                operations: operations as any,
                plan: plan as any,
                persistResult,
                observabilityContext: ctx
            }
            await mutationHooks.events.committed.emit(committedEvent as any)

            operations.forEach((op, idx) => {
                op.ticket?.settle('enqueued')
                if (persistResult.status === 'confirmed') {
                    op.ticket?.settle('confirmed')
                }

                const payload = plan.appliedData[idx]
                if (op.type === 'add' || op.type === 'create' || op.type === 'update' || op.type === 'upsert') {
                    (op as any).onSuccess?.(payload ?? ((op as any).data as any))
                    return
                }
                (op as any).onSuccess?.()
            })
        } catch (error) {
            await mutationHooks.events.persistError.emit({ ctx: persistCtx, error })
            const rollbackState = ((plan as any)?.baseState as any) ?? originalState
            this.committer.rollback({
                atom,
                store,
                plan,
                originalState: rollbackState,
                indexes
            })
            const rolledBackEvent: RolledBackEvent<T> = {
                storeName: persistCtx.storeName,
                opContext: persistCtx.opContext,
                handle,
                operations: operations as any,
                plan: plan as any,
                error,
                observabilityContext: ctx
            }
            await mutationHooks.events.rolledBack.emit(rolledBackEvent as any)
            ctx.emit('mutation:rollback', { reason: 'adapter_error' })
            const err = error instanceof Error ? error : new Error(String(error))
            operations.forEach((op) => {
                op.ticket?.settle('enqueued', err)
                op.onFail?.(err)
            })
        }
    }
}
