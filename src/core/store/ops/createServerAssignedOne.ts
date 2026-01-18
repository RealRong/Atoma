import type { CoreRuntime, Entity, StoreOperationOptions } from '../../types'
import { dispatch } from '../internals/dispatch'
import type { StoreHandle } from '../internals/handleTypes'

export function createCreateServerAssignedOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    return async (item: Partial<T>, options?: StoreOperationOptions): Promise<T> => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            const anyItem: any = item as any
            if (anyItem.id !== undefined && anyItem.id !== null) {
                throw new Error('[Atoma] createServerAssignedOne: 不允许传入 id（Server-ID create 由服务端分配 id）')
            }
        }
        if (options?.confirmation && options.confirmation !== 'strict') {
            throw new Error('[Atoma] createServerAssignedOne: confirmation 必须为 strict（Server-ID create 不支持 optimistic）')
        }

        const strictOptions: StoreOperationOptions = { ...(options || {}), confirmation: 'strict' }
        const { ticket } = clientRuntime.mutation.api.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            dispatch<T>(clientRuntime, {
                type: 'create',
                data: item,
                handle,
                opContext: strictOptions.opContext,
                ticket,
                persist: 'direct',
                onSuccess: (o: T) => resolve(o),
                onFail: (error?: Error) => reject(error || new Error('[Atoma] createServerAssignedOne failed'))
            } as any)
        })

        await Promise.all([
            resultPromise,
            clientRuntime.mutation.api.awaitTicket(ticket, strictOptions)
        ])

        return resultPromise
    }
}
