import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions, UpsertWriteOptions } from '../../types'
import { dispatch } from '../internals/dispatch'
import { runAfterSave, runBeforeSave } from '../internals/hooks'
import { validateWithSchema } from '../internals/validation'
import { prepareForAdd, prepareForUpdate } from '../internals/writePipeline'

export function createUpsertOne<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, services, hooks } = handle

    return async (
        item: PartialWithId<T>,
        options?: StoreOperationOptions & UpsertWriteOptions
    ): Promise<T> => {
        const id: StoreKey = item.id
        const base = jotaiStore.get(atom).get(id) as PartialWithId<T> | undefined
        const merge = options?.merge !== false

        const validObj = await (async () => {
            if (!base) {
                return await prepareForAdd<T>(handle, item as any)
            }

            if (merge) {
                return await prepareForUpdate<T>(handle, base, item)
            }

            const createdAt = (base as any).createdAt ?? Date.now()
            const candidate: any = {
                ...(item as any),
                id,
                createdAt,
                updatedAt: Date.now()
            }

            if (candidate.version === undefined && typeof (base as any).version === 'number') {
                candidate.version = (base as any).version
            }
            if (candidate._etag === undefined && typeof (base as any)._etag === 'string') {
                candidate._etag = (base as any)._etag
            }

            let next = await runBeforeSave(handle.hooks, candidate as any, 'update')
            next = handle.transform(next as any) as any
            next = await validateWithSchema(next as any, handle.schema as any)
            return next as PartialWithId<T>
        })()

        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>({
                type: 'upsert',
                data: validObj,
                upsert: {
                    mode: options?.mode,
                    merge: options?.merge
                },
                handle,
                opContext: options?.opContext,
                ticket,
                onSuccess: async (o) => {
                    await runAfterSave(hooks, validObj, base ? 'update' : 'add')
                    resolve(o)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to upsert item with id ${String(id)}`))
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
