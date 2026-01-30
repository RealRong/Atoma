/**
 * Mutation Pipeline: Persist
 * Purpose: Delegates persistence side-effects to `CoreRuntime.persistence.persist`.
 * Call chain: executeMutationFlow -> executeMutationPersistence -> runtime.persistence.persist.
 */
import type { CoreRuntime, Entity, StoreDispatchEvent } from '../../types'
import type { PersistResult, WriteStrategy } from '../../types'
import type { MutationProgram } from './types'
import type { ObservabilityContext } from 'atoma-observability'
import type { StoreHandle } from '../../store/internals/handleTypes'

export function deriveWriteStrategyFromOperations<T extends Entity>(operations: Array<StoreDispatchEvent<T>>): WriteStrategy | undefined {
    const set = new Set<string>()
    for (const op of operations) {
        const k = op.writeStrategy
        if (typeof k === 'string' && k) set.add(k)
    }
    if (set.size === 0) return undefined
    if (set.size === 1) return Array.from(set)[0]
    throw new Error('[Atoma] mixed write strategies in one mutation segment')
}

export async function executeMutationPersistence<T extends Entity>(args: {
    clientRuntime: CoreRuntime
    handle: StoreHandle<T>
    program: MutationProgram<T>
    context?: ObservabilityContext
}): Promise<PersistResult<T>> {
    return await args.clientRuntime.persistence.persist({
        storeName: String(args.handle.storeName),
        writeStrategy: args.program.writeStrategy,
        handle: args.handle,
        writeOps: args.program.writeOps,
        context: args.context
    })
}
