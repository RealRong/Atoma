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
                    reject(error || new Error(`Failed to delete item with id ${String(id)}`))
                }
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            void ticket.enqueued.catch(() => {
                // avoid unhandled rejection when optimistic writes never await enqueued
            })
            void ticket.confirmed.catch(() => {
                // avoid unhandled rejection when optimistic writes never await confirmed
            })
            return await resultPromise
        }

        const [value] = await Promise.all([
            resultPromise,
            services.mutation.runtime.await(ticket, options)
        ])

        return value
    }
}
