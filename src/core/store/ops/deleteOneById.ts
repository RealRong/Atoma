import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreOperationOptions } from '../../types'
import { dispatch } from '../internals/dispatch'

export function createDeleteOneById<T extends Entity>(handle: StoreHandle<T>) {
    const { services } = handle
    return async (id: StoreKey, options?: StoreOperationOptions) => {
        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<boolean>((resolve, reject) => {
            dispatch<T>({
                type: options?.force ? 'forceRemove' : 'remove',
                data: { id } as PartialWithId<T>,
                handle,
                opContext: options?.opContext,
                ticket,
                onSuccess: () => {
                    resolve(true)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to delete item with id ${id}`))
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
