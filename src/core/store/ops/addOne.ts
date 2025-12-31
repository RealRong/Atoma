import type { Entity, PartialWithId, StoreOperationOptions, StoreHandle } from '../../types'
import { dispatch } from '../internals/dispatch'
import { runAfterSave } from '../internals/hooks'
import { prepareForAdd } from '../internals/writePipeline'

export function createAddOne<T extends Entity>(handle: StoreHandle<T>) {
    const { services, hooks } = handle
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await prepareForAdd<T>(handle, obj)
        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>({
                type: 'add',
                data: validObj as PartialWithId<T>,
                handle,
                opContext: options?.opContext,
                ticket,
                onSuccess: async o => {
                    await runAfterSave(hooks, validObj, 'add')
                    resolve(o)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to add item with id ${(validObj as any).id}`))
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
