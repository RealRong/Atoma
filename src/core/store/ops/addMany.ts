import type { ClientRuntime, Entity, StoreOperationOptions, StoreHandle } from '../../types'
import { dispatch } from '../internals/dispatch'
import { ensureActionId } from '../internals/ensureActionId'
import { runAfterSave } from '../internals/hooks'
import { ignoreTicketRejections } from '../internals/tickets'
import { prepareForAdd } from '../internals/writePipeline'
import type { StoreWriteConfig } from '../internals/writeConfig'

export function createAddMany<T extends Entity>(
    clientRuntime: ClientRuntime,
    handle: StoreHandle<T>,
    writeConfig: StoreWriteConfig
) {
    const { hooks } = handle
    return async (items: Array<Partial<T>>, options?: StoreOperationOptions) => {
        const opContext = ensureActionId(options?.opContext)

        const validItems = await Promise.all(items.map(item => prepareForAdd<T>(handle, item)))
        const results: T[] = new Array(validItems.length)

        const tickets = new Array(validItems.length)
        const resultPromises = validItems.map((validObj, idx) => {
            const { ticket } = clientRuntime.mutation.api.beginWrite()
            tickets[idx] = ticket

            return new Promise<void>((resolve, reject) => {
                dispatch<T>(clientRuntime, {
                    type: 'add',
                    data: validObj as any,
                    handle,
                    opContext,
                    ticket,
                    persist: writeConfig.persistMode,
                    onSuccess: (o) => {
                        void runAfterSave(hooks, validObj as any, 'add')
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
                ignoreTicketRejections(ticket)
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
