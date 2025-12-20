import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey, StoreOperationOptions } from '../types'
import { type StoreRuntime, resolveObservabilityContext } from './runtime'

export function createDeleteOneById<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexes } = runtime
    return (id: StoreKey, options?: StoreOperationOptions) => {
        return new Promise<boolean>((resolve, reject) => {
            const observabilityContext = resolveObservabilityContext(runtime, options)
            const traceId = observabilityContext.traceId
            BaseStore.dispatch({
                type: options?.force ? 'forceRemove' : 'remove',
                data: { id } as PartialWithId<T>,
                adapter,
                atom,
                store: jotaiStore,
                context,
                indexes,
                traceId,
                observabilityContext,
                opContext: options?.opContext,
                onSuccess: () => {
                    resolve(true)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to delete item with id ${id}`))
                }
            })
        })
    }
}
