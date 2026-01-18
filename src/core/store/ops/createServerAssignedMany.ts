import type { Entity, StoreHandle, StoreOperationOptions } from '../../types'
import { dispatch } from '../internals/dispatch'
import { ensureActionId } from '../internals/ensureActionId'

export function createCreateServerAssignedMany<T extends Entity>(handle: StoreHandle<T>) {
    const { services } = handle

    return async (items: Array<Partial<T>>, options?: StoreOperationOptions): Promise<T[]> => {
        for (const item of items) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const anyItem: any = item as any
                if (anyItem.id !== undefined && anyItem.id !== null) {
                    throw new Error('[Atoma] createServerAssignedMany: 不允许传入 id（Server-ID create 由服务端分配 id）')
                }
            }
        }
        if (options?.confirmation && options.confirmation !== 'strict') {
            throw new Error('[Atoma] createServerAssignedMany: confirmation 必须为 strict（Server-ID create 不支持 optimistic）')
        }

        const strictOptions: StoreOperationOptions = { ...(options || {}), confirmation: 'strict' }
        const opContext = ensureActionId(strictOptions.opContext)

        const results: T[] = new Array(items.length)
        const tickets = new Array(items.length)

        const tasks = items.map((item, idx) => {
            const { ticket } = services.mutation.api.beginWrite()
            tickets[idx] = ticket

            const resultPromise = new Promise<void>((resolve, reject) => {
                dispatch<T>({
                    type: 'create',
                    data: item,
                    handle,
                    opContext,
                    ticket,
                    persist: 'direct',
                    onSuccess: (o: T) => {
                        results[idx] = o
                        resolve()
                    },
                    onFail: (error?: Error) => reject(error || new Error('[Atoma] createServerAssignedMany failed'))
                } as any)
            })

            return Promise.all([
                resultPromise,
                services.mutation.api.awaitTicket(ticket, strictOptions)
            ])
        })

        await Promise.all(tasks)
        return results
    }
}
