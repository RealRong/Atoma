import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import { dispatch } from '../internals/dispatch'
import { runAfterSave } from '../internals/hooks'
import { ignoreTicketRejections, prepareForAdd, type StoreWriteConfig } from '../internals/writePipeline'
import type { StoreHandle } from '../internals/handleTypes'

export function createAddOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { hooks } = handle
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await prepareForAdd<T>(handle, obj)
        const { ticket } = clientRuntime.mutation.api.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>(clientRuntime, {
                type: 'add',
                data: validObj,
                handle,
                opContext: options?.opContext,
                ticket,
                persist: writeConfig.persistMode,
                onSuccess: (o) => {
                    void runAfterSave(hooks, validObj, 'add')
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
