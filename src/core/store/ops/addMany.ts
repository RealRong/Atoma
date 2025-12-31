import type { Entity, StoreOperationOptions, StoreHandle } from '../../types'
import { dispatch } from '../internals/dispatch'
import { ensureActionId } from '../internals/ensureActionId'
import { runAfterSave } from '../internals/hooks'
import { prepareForAdd } from '../internals/writePipeline'

export function createAddMany<T extends Entity>(handle: StoreHandle<T>) {
    const { services, hooks } = handle
    return async (items: Array<Partial<T>>, options?: StoreOperationOptions) => {
        const opContext = ensureActionId(options?.opContext)

        const validItems = await Promise.all(items.map(item => prepareForAdd<T>(handle, item)))
        const results: T[] = new Array(validItems.length)

        const tickets = validItems.map(() => services.mutation.runtime.beginWrite().ticket)
        const resultPromises = validItems.map((validObj, idx) => new Promise<void>((resolve, reject) => {
            dispatch<T>({
                type: 'add',
                data: validObj as any,
                handle,
                opContext,
                ticket: tickets[idx],
                onSuccess: async (o) => {
                    await runAfterSave(hooks, validObj as any, 'add')
                    results[idx] = o
                    resolve()
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to add item at index ${idx}`))
                }
            })
        }))

        await Promise.all([
            ...tickets.map(ticket => services.mutation.runtime.await(ticket, options)),
            ...resultPromises
        ])

        return results
    }
}
