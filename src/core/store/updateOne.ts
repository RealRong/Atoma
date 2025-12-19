import { BaseStore } from '../BaseStore'
import { produce } from 'immer'
import type { Draft } from 'immer'
import type { Entity, PartialWithId, StoreKey, StoreOperationOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { runAfterSave } from './hooks'
import { validateWithSchema } from './validation'
import { type StoreRuntime, resolveInternalOperationContext } from './runtime'
import { prepareForUpdate } from './writePipeline'

export function createUpdateOne<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexes, hooks, schema, transform } = runtime
    return (id: StoreKey, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
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
                    indexes,
                    traceId,
                    opContext: options?.opContext,
                    onSuccess: async updated => {
                        await runAfterSave(hooks, validObj, 'update')
                        resolve(updated)
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to update item with id ${id}`))
                    }
                })
            }

            const updateFromBase = (base: PartialWithId<T>) => {
                const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
                const patched = { ...(next as any), id } as PartialWithId<T>
                prepareForUpdate<T>(runtime, base, patched).then(dispatchUpdate).catch(reject)
            }

            const cached = jotaiStore.get(atom).get(id) as T | undefined
            if (cached) {
                updateFromBase(cached as unknown as PartialWithId<T>)
                return
            }

            adapter.get(id, internalContext).then(data => {
                if (!data) {
                    reject(new Error(`Item with id ${id} not found`))
                    return
                }

                const transformed = transform(data)
                validateWithSchema(transformed, schema)
                    .then(validFetched => {
                        const before = jotaiStore.get(atom)
                        const after = BaseStore.add(validFetched as PartialWithId<T>, before)
                        commitAtomMapUpdate({ jotaiStore, atom, before, after, context, indexes })
                        updateFromBase(validFetched as unknown as PartialWithId<T>)
                    })
                    .catch(err => reject(err))
            }).catch(error => {
                reject(error)
            })
        })
    }
}
