import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreOperationOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { runAfterSave } from './hooks'
import { validateWithSchema } from './validation'
import { type StoreRuntime, resolveInternalOperationContext } from './runtime'
import { prepareForUpdate } from './writePipeline'

export function createUpdateOne<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexManager, hooks, schema, transform, resolveOperationTraceId, storeName } = runtime
    return (obj: PartialWithId<T>, options?: StoreOperationOptions) => {
        return new Promise<T>((resolve, reject) => {
            const internalContext = resolveInternalOperationContext(runtime, options)
            const traceId = internalContext?.traceId

            const dispatchUpdate = (validObj: PartialWithId<T>) => {
                BaseStore.dispatch({
                    type: 'update',
                    atom,
                    adapter,
                    data: validObj,
                    store: jotaiStore,
                    context,
                    traceId,
                    onSuccess: async updated => {
                        await runAfterSave(hooks, validObj, 'update')
                        resolve(updated)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to update item with id ${obj.id}`))
                    }
                })
            }

            const updateFromBase = (base: PartialWithId<T>) => {
                prepareForUpdate<T>(runtime, base, obj).then(dispatchUpdate).catch(reject)
            }

            const cached = jotaiStore.get(atom).get(obj.id) as T | undefined
            if (cached) {
                updateFromBase(cached as unknown as PartialWithId<T>)
                return
            }

            adapter.get(obj.id, internalContext).then(data => {
                if (!data) {
                    reject(new Error(`Item with id ${obj.id} not found`))
                    return
                }

                const transformed = transform(data)
                validateWithSchema(transformed, schema)
                    .then(validFetched => {
                        const before = jotaiStore.get(atom)
                        const after = BaseStore.add(validFetched as PartialWithId<T>, before)
                        commitAtomMapUpdate({ jotaiStore, atom, before, after, context, indexManager })
                        updateFromBase(validFetched as unknown as PartialWithId<T>)
                    })
                    .catch(err => reject(err))
            }).catch(error => {
                reject(error)
            })
        })
    }
}
