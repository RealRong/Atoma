import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import type { StoreHandle } from '../internals/handleTypes'

export function createAddMany<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { hooks } = handle
    const write = clientRuntime.write
    return async (items: Array<Partial<T>>, options?: StoreOperationOptions) => {
        const opContext = write.ensureActionId(options?.opContext)
        const writeStrategy = write.resolveWriteStrategy(handle, options)

        const validItems = await Promise.all(items.map(item => write.prepareForAdd<T>(handle, item, opContext)))
        const results: T[] = new Array(validItems.length)

        const tickets = new Array(validItems.length)
        const resultPromises = validItems.map((validObj, idx) => {
            const { ticket } = clientRuntime.mutation.begin()
            tickets[idx] = ticket

            return new Promise<void>((resolve, reject) => {
                write.dispatch<T>({
                    type: 'add',
                    data: validObj as any,
                    handle,
                    opContext,
                    ticket,
                    writeStrategy,
                    onSuccess: (o) => {
                        void write.runAfterSave(hooks, validObj as any, 'add')
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
                write.ignoreTicketRejections(ticket)
            })
            await Promise.all(resultPromises)
            return results
        }

        await Promise.all([
            ...tickets.map(ticket => clientRuntime.mutation.await(ticket, options)),
            ...resultPromises
        ])

        return results
    }
}
