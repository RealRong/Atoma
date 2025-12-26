import { BaseStore } from '../BaseStore'
import { produce } from 'immer'
import type { Draft } from 'immer'
import type { Entity, PartialWithId, StoreKey, StoreOperationOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { runAfterSave } from './hooks'
import { validateWithSchema } from './validation'
import { resolveObservabilityContext } from './runtime'
import { prepareForUpdate } from './writePipeline'
import type { StoreHandle } from '../types'

export function createUpdateOne<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, adapter, services, hooks, schema, transform } = handle
    return async (id: StoreKey, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
        const observabilityContext = resolveObservabilityContext(handle, options)

        const resolveBase = async (): Promise<PartialWithId<T>> => {
            const cached = jotaiStore.get(atom).get(id) as T | undefined
            if (cached) {
                return cached as unknown as PartialWithId<T>
            }

            const data = await adapter.get(id, observabilityContext)
            if (!data) {
                throw new Error(`Item with id ${id} not found`)
            }

            const transformed = transform(data)
            const validFetched = await validateWithSchema(transformed, schema)
            const before = jotaiStore.get(atom)
            const after = BaseStore.add(validFetched as PartialWithId<T>, before)
            commitAtomMapUpdate({ handle, before, after })
            return validFetched as unknown as PartialWithId<T>
        }

        const base = await resolveBase()

        const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
        const patched = { ...(next as any), id } as PartialWithId<T>
        const validObj = await prepareForUpdate<T>(handle, base, patched)

        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            BaseStore.dispatch({
                type: 'update',
                handle,
                data: validObj,
                opContext: options?.opContext,
                ticket,
                onSuccess: async updated => {
                    await runAfterSave(hooks, validObj, 'update')
                    resolve(updated)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to update item with id ${id}`))
                }
            })
        })

        await Promise.all([
            services.mutation.runtime.await(ticket, options),
            resultPromise
        ])

        return resultPromise
    }
}
