import { Reducer } from './Reducer'
import type { Entity, PatchMetadata, StoreDispatchEvent, StoreKey } from '../../types'
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
import type { BeforePersistContext, CommittedEvent, PersistResult, RolledBackEvent } from '../hooks'

class DefaultPlanner implements Planner {
    private readonly reducer = new Reducer()

    plan<T extends Entity>(
        operations: StoreDispatchEvent<T>[],
        currentState: Map<StoreKey, T>
    ): Plan<T> {
        return this.reducer.reduce(operations, currentState)
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
        const { handle, operations, plan, atom, store, versionTracker, indexes } = args
        const ctx = args.observabilityContext
        const traceId = ctx.traceId
        const mutationHooks = handle.services.mutation.hooks
        const storeName = args.storeName ?? handle.storeName

        const originalState = store.get(atom)

        const clientTimeMs = operations.find(op => typeof op.ticket?.clientTimeMs === 'number')?.ticket?.clientTimeMs

        const metadata: PatchMetadata = {
            atom,
            databaseName: handle.dataSource.name,
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
            versionTracker,
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
            const basePersist = async (baseCtx: BeforePersistContext<T>): Promise<PersistResult<T>> => {
                const res: PersisterPersistResult<T> = await this.directPersister.persist({
                    handle: baseCtx.handle,
                    operations: baseCtx.operations,
                    plan: baseCtx.plan,
                    metadata: baseCtx.metadata,
                    observabilityContext: baseCtx.observabilityContext
                })

                const createdResults = (res && typeof res === 'object' && Array.isArray((res as any).created))
                    ? ((res as any).created as T[])
                    : undefined

                return {
                    mode: 'direct',
                    status: 'confirmed',
                    ...(createdResults ? { created: createdResults } : {})
                }
            }

            const persistResult = await mutationHooks.middleware.beforePersist.run(persistCtx, basePersist as any)

            await mutationHooks.events.afterPersist.emit({ ctx: persistCtx, result: persistResult })

            const createdResults = persistResult.created

            this.committer.commit({
                atom,
                store,
                plan,
                createdResults,
                versionTracker,
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
                if (op.type === 'add' || op.type === 'update') {
                    op.onSuccess?.(payload ?? (op.data as any))
                    return
                }
                op.onSuccess?.()
            })
        } catch (error) {
            await mutationHooks.events.persistError.emit({ ctx: persistCtx, error })
            this.committer.rollback({
                atom,
                store,
                plan,
                originalState,
                versionTracker,
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
