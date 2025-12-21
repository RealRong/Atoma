import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreOperationOptions } from '../types'
import { runAfterSave } from './hooks'
import { type StoreRuntime, resolveObservabilityContext } from './runtime'
import { prepareForAdd } from './writePipeline'

export function createAddOne<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, hooks, indexes } = runtime
    return (obj: Partial<T>, options?: StoreOperationOptions) => {
        return new Promise<T>((resolve, reject) => {
            prepareForAdd<T>(runtime, obj).then(validObj => {
                const observabilityContext = resolveObservabilityContext(runtime, options)
                BaseStore.dispatch<T>({
                    type: 'add',
                    data: validObj as PartialWithId<T>,
                    adapter,
                    atom,
                    store: jotaiStore,
                    context,
                    indexes,
                    observabilityContext,
                    opContext: options?.opContext,
                    onSuccess: async o => {
                        await runAfterSave(hooks, validObj, 'add')
                        resolve(o)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to add item with id ${(validObj as any).id}`))
                    }
                })
            }).catch(reject)
        })
    }
}
