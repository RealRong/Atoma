import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import type { StoreHandle } from '../internals/handleTypes'

export function createAddOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { hooks } = handle
    const write = clientRuntime.storeWrite
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await write.prepareForAdd<T>(handle, obj, options?.opContext)
        const { ticket } = clientRuntime.mutation.api.beginWrite()
        const writeStrategy = write.resolveWriteStrategy(handle, options)

        const resultPromise = new Promise<T>((resolve, reject) => {
            write.dispatch<T>({
                type: 'add',
                data: validObj,
                handle,
                opContext: options?.opContext,
                ticket,
                writeStrategy,
                onSuccess: (o) => {
                    void write.runAfterSave(hooks, validObj, 'add')
                        .then(() => {
                            resolve(o)
                        })
                        .catch((error) => {
                            reject(error instanceof Error ? error : new Error(String(error)))
                        })
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to add item with id ${String((validObj as any).id)}`))
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
            clientRuntime.mutation.api.awaitTicket(ticket, options)
        ])

        return value
    }
}
