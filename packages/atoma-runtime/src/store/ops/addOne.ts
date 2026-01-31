import type { CoreRuntime, Entity, StoreOperationOptions } from 'atoma-core/internal'
import type { StoreHandle } from 'atoma-core/internal'

export function createAddOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { hooks } = handle
    const write = clientRuntime.write
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await write.prepareForAdd<T>(handle, obj, options?.opContext)
        const { ticket } = clientRuntime.mutation.begin()
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
            clientRuntime.mutation.await(ticket, options)
        ])

        return value
    }
}
