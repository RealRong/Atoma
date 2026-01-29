import type { CoreRuntime, Entity, PartialWithId, StoreOperationOptions } from '../../types'
import type { EntityId } from '#protocol'
import type { StoreHandle } from '../internals/handleTypes'

export function createDeleteOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const write = clientRuntime.write
    return async (id: EntityId, options?: StoreOperationOptions) => {
        const { ticket } = clientRuntime.mutation.begin()
        const writeStrategy = write.resolveWriteStrategy(handle, options)

        const resultPromise = new Promise<boolean>((resolve, reject) => {
            write.dispatch<T>({
                type: options?.force ? 'forceRemove' : 'remove',
                data: { id } as PartialWithId<T>,
                handle,
                opContext: options?.opContext,
                ticket,
                writeStrategy,
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
            write.ignoreTicketRejections(ticket)
            return resultPromise
        }

        const [value] = await Promise.all([
            resultPromise,
            clientRuntime.mutation.await(ticket, options)
        ])

        return value
    }
}
