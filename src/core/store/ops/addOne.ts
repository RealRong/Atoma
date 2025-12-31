import type { Entity, StoreOperationOptions, StoreHandle } from '../../types'
import { dispatch } from '../internals/dispatch'
import { runAfterSave } from '../internals/hooks'
import { ignoreTicketRejections } from '../internals/tickets'
import { prepareForAdd } from '../internals/writePipeline'

export function createAddOne<T extends Entity>(handle: StoreHandle<T>) {
    const { services, hooks } = handle
    return async (obj: Partial<T>, options?: StoreOperationOptions) => {
        const validObj = await prepareForAdd<T>(handle, obj)
        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>({
                type: 'add',
                data: validObj,
                handle,
                opContext: options?.opContext,
                ticket,
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
            services.mutation.runtime.await(ticket, options)
        ])

        return value
    }
}
