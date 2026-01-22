import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import { storeWriteEngine, type StoreWriteConfig } from '../internals/storeWriteEngine'
import type { StoreHandle } from '../internals/handleTypes'

export function createAddOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { hooks } = handle
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await storeWriteEngine.prepareForAdd<T>(clientRuntime, handle, obj, options?.opContext)
        const { ticket } = clientRuntime.mutation.api.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            storeWriteEngine.dispatch<T>(clientRuntime, {
                type: 'add',
                data: validObj,
                handle,
                opContext: options?.opContext,
                ticket,
                persistKey: writeConfig.persistKey,
                onSuccess: (o) => {
                    void storeWriteEngine.runAfterSave(hooks, validObj, 'add')
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
            storeWriteEngine.ignoreTicketRejections(ticket)
            return resultPromise
        }

        const [value] = await Promise.all([
            resultPromise,
            clientRuntime.mutation.api.awaitTicket(ticket, options)
        ])

        return value
    }
}
