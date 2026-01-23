import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import { storeWriteEngine, type StoreWriteConfig } from '../internals/storeWriteEngine'
import type { StoreHandle } from '../internals/handleTypes'

export function createAddMany<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { hooks } = handle
    return async (items: Array<Partial<T>>, options?: StoreOperationOptions) => {
        const opContext = storeWriteEngine.ensureActionId(options?.opContext)

        const validItems = await Promise.all(items.map(item => storeWriteEngine.prepareForAdd<T>(clientRuntime, handle, item, opContext)))
        const results: T[] = new Array(validItems.length)

        const tickets = new Array(validItems.length)
        const resultPromises = validItems.map((validObj, idx) => {
            const { ticket } = clientRuntime.mutation.api.beginWrite()
            tickets[idx] = ticket

            return new Promise<void>((resolve, reject) => {
                storeWriteEngine.dispatch<T>(clientRuntime, {
                    type: 'add',
                    data: validObj as any,
                    handle,
                    opContext,
                    ticket,
                    writeStrategy: writeConfig.writeStrategy,
                    onSuccess: (o) => {
                        void storeWriteEngine.runAfterSave(hooks, validObj as any, 'add')
                            .then(() => {
                                results[idx] = o
                                resolve()
                            })
                            .catch((error) => {
                                reject(error instanceof Error ? error : new Error(String(error)))
                            })
                    },
                    onFail: (error) => {
                        reject(error || new Error(`Failed to add item at index ${idx}`))
                    }
                })
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            tickets.forEach((ticket) => {
                storeWriteEngine.ignoreTicketRejections(ticket)
            })
            await Promise.all(resultPromises)
            return results
        }

        await Promise.all([
            ...tickets.map(ticket => clientRuntime.mutation.api.awaitTicket(ticket, options)),
            ...resultPromises
        ])

        return results
    }
}
