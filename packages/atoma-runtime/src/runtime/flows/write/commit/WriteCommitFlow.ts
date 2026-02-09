import type {
    Entity,
    StoreWritebackArgs,
    WriteIntent
} from 'atoma-types/core'
import type {
    EntityId,
    OperationResult,
    WriteAction,
    WriteItemResult,
    WriteOp,
    WriteResultData
} from 'atoma-types/protocol'
import type {
    StoreHandle,
    WritePolicy
} from 'atoma-types/runtime'
import type { ExecuteWriteRequest, OptimisticState, PersistPlan } from '../types'
import { WriteOpsBuilder } from './WriteOpsBuilder'

function applyIntentsOptimistically<T extends Entity>(
    baseState: Map<EntityId, T>,
    intents: Array<WriteIntent<T>>,
    preserve: (existing: T | undefined, incoming: T) => T
): { afterState: Map<EntityId, T> } {
    let nextState = baseState

    const ensureMutableState = () => {
        if (nextState === baseState) {
            nextState = new Map(baseState)
        }
        return nextState
    }

    const upsert = (id: EntityId, value: T) => {
        const currentState = nextState === baseState ? baseState : nextState
        const current = currentState.get(id)
        const preserved = preserve(current, value)
        if (currentState.has(id) && current === preserved) return
        ensureMutableState().set(id, preserved)
    }

    const remove = (id: EntityId) => {
        const currentState = nextState === baseState ? baseState : nextState
        if (!currentState.has(id)) return
        ensureMutableState().delete(id)
    }

    for (const intent of intents) {
        const entityId = intent.entityId
        if (!entityId) continue

        if (intent.action === 'delete') {
            remove(entityId as EntityId)
            continue
        }

        if (intent.value !== undefined) {
            upsert(entityId as EntityId, intent.value as T)
        }
    }

    return { afterState: nextState }
}

function applyOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    intents: Array<WriteIntent<T>>
    writePolicy: WritePolicy
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, intents, writePolicy, preserve } = args
    const beforeState = handle.state.getSnapshot() as Map<EntityId, T>
    const shouldOptimistic = writePolicy.optimistic !== false

    const optimistic = (shouldOptimistic && intents.length)
        ? applyIntentsOptimistically(beforeState, intents, preserve)
        : { afterState: beforeState }

    const { afterState } = optimistic
    if (afterState !== beforeState) {
        handle.state.commit({
            before: beforeState,
            after: afterState
        })
    }

    return {
        beforeState,
        afterState
    }
}

function rollbackOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    optimisticState: OptimisticState<T>
}) {
    const { handle, optimisticState } = args
    if (optimisticState.afterState !== optimisticState.beforeState) {
        handle.state.commit({
            before: optimisticState.afterState,
            after: optimisticState.beforeState
        })
    }
}

async function resolveWriteResultFromOperationResults<T extends Entity>(args: {
    runtime: ExecuteWriteRequest<T>['runtime']
    handle: ExecuteWriteRequest<T>['handle']
    plan: PersistPlan<T>
    results: OperationResult[]
    primaryIntent?: WriteIntent<T>
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    if (!args.plan.length || !args.results.length) return {}

    const resultByOpId = new Map<string, OperationResult>()
    args.results.forEach(result => resultByOpId.set(result.opId, result))

    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    let output: T | undefined

    const primary = args.primaryIntent
        ? { action: args.primaryIntent.action, entityId: args.primaryIntent.entityId }
        : undefined

    for (const entry of args.plan) {
        const operationResult = resultByOpId.get(entry.op.opId)
        if (!operationResult) throw new Error('[Atoma] missing operation result')

        if (!operationResult.ok) {
            const error = new Error(`[Atoma] op failed: ${operationResult.error.message || 'Operation failed'}`)
            ;(error as { error?: unknown }).error = operationResult.error
            throw error
        }

        const itemResults = resolveWriteItemResults(operationResult)
        const shouldApplyData = shouldApplyReturnedData(entry.op)

        for (const itemResult of itemResults) {
            const intent = entry.intents[itemResult.index]
            if (!intent) throw new Error('[Atoma] write item result index out of range')
            if (!itemResult.ok) throw toWriteItemError(entry.op.write.action, itemResult)

            if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
                const entityId = itemResult.entityId ?? intent.entityId
                if (entityId) {
                    versionUpdates.push({ key: entityId, version: itemResult.version })
                }
            }

            if (!shouldApplyData || !itemResult.data || typeof itemResult.data !== 'object') continue

            const normalized = await args.runtime.transform.writeback(args.handle, itemResult.data as T)
            if (!normalized) continue

            upserts.push(normalized)
            if (!output && primary && intent.action === primary.action) {
                if (!primary.entityId || intent.entityId === primary.entityId) {
                    output = normalized
                }
            }
        }
    }

    const writeback = (upserts.length || versionUpdates.length)
        ? ({
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        } as StoreWritebackArgs<T>)
        : undefined

    return { writeback, output }
}

function resolveWriteItemResults(operationResult: OperationResult): WriteItemResult[] {
    if (!operationResult.ok) return []

    const data = operationResult.data as WriteResultData | undefined
    if (!data || !Array.isArray(data.results) || !data.results.length) {
        throw new Error('[Atoma] missing write item results')
    }

    for (const itemResult of data.results) {
        if (typeof itemResult.index !== 'number' || !Number.isFinite(itemResult.index)) {
            throw new Error('[Atoma] write item result missing index')
        }
    }

    return data.results
}

function shouldApplyReturnedData(op: WriteOp): boolean {
    const options = op.write.options
    if (!options) return true
    if (options.returning === false) return false

    const select = options.select
    if (select && typeof select === 'object' && Object.keys(select).length > 0) {
        return false
    }

    return true
}

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)

    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(error as { error?: unknown }).error = result.error
    return error
}

export class WriteCommitFlow {
    private readonly opsBuilder = new WriteOpsBuilder()

    execute = async <T extends Entity>(args: ExecuteWriteRequest<T>): Promise<T | void> => {
        const intents = args.intents
        const writePolicy = args.runtime.strategy.resolveWritePolicy(args.writeStrategy)
        const optimisticState = applyOptimisticState({
            handle: args.handle,
            intents,
            writePolicy,
            preserve: args.runtime.engine.mutation.preserveRef
        })

        const { runtime, handle, opContext } = args

        try {
            const plan = await this.opsBuilder.buildWriteOps({
                runtime,
                handle,
                intents,
                opContext
            })

            const writeOps = plan.map(entry => entry.op)
            if (!writeOps.length) {
                const primary = intents.length === 1 ? intents[0] : undefined
                if (primary && primary.action !== 'delete') {
                    return primary.value as T
                }
                return undefined
            }

            const persistResult = await runtime.strategy.persist({
                storeName: String(handle.storeName),
                writeStrategy: args.writeStrategy,
                handle,
                opContext,
                writeOps
            })

            const primaryIntent = intents.length === 1 ? intents[0] : undefined
            const resolved = (persistResult.results && persistResult.results.length)
                ? await resolveWriteResultFromOperationResults<T>({
                    runtime,
                    handle,
                    plan,
                    results: persistResult.results,
                    primaryIntent
                })
                : {}

            if (resolved.writeback) {
                handle.state.applyWriteback(resolved.writeback)
            }

            return resolved.output ?? (primaryIntent?.value as T | undefined)
        } catch (error) {
            rollbackOptimisticState({
                handle,
                optimisticState
            })
            throw error
        }
    }
}
