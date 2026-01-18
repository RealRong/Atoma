import type { Entity, PartialWithId, StoreHandle, StoreOperationOptions } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { ignoreTicketRejections } from '../internals/tickets'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createDeleteOne<T extends Entity>(handle: StoreHandle<T>, writeConfig: StoreWriteConfig) {
    const { services } = handle
    return async (id: EntityId, options?: StoreOperationOptions) => {
        const { ticket } = services.mutation.api.beginWrite()

        const resultPromise = new Promise<boolean>((resolve, reject) => {
            dispatch<T>({
                type: options?.force ? 'forceRemove' : 'remove',
                data: { id } as PartialWithId<T>,
                handle,
                opContext: options?.opContext,
                ticket,
                persist: writeConfig.persistMode,
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
            ignoreTicketRejections(ticket)
            return resultPromise
        }

        const [value] = await Promise.all([
            resultPromise,
            services.mutation.api.awaitTicket(ticket, options)
        ])

        return value
    }
}
