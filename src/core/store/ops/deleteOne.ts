import type { ClientRuntime, Entity, PartialWithId, StoreHandle, StoreOperationOptions } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { ignoreTicketRejections } from '../internals/tickets'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createDeleteOne<T extends Entity>(
    clientRuntime: ClientRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    return async (id: EntityId, options?: StoreOperationOptions) => {
        const { ticket } = clientRuntime.mutation.api.beginWrite()

        const resultPromise = new Promise<boolean>((resolve, reject) => {
            dispatch<T>(clientRuntime, {
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
            clientRuntime.mutation.api.awaitTicket(ticket, options)
        ])

        return value
    }
}
