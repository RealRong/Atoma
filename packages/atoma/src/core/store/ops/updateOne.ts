import { produce } from 'immer'
import type { Draft } from 'immer'
import type { CoreRuntime, Entity, PartialWithId, StoreOperationOptions } from '../../types'
import type { EntityId } from '#protocol'
import { resolveObservabilityContext } from '../internals/storeHandleManager'
import { storeWriteEngine } from '../internals/storeWriteEngine'
import type { StoreHandle } from '../internals/handleTypes'

export function createUpdateOne<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
) {
    const { jotaiStore, atom, hooks } = handle
    return async (id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)
        const writeStrategy = storeWriteEngine.resolveWriteStrategy(handle, options)
        const allowImplicitFetchForWrite = storeWriteEngine.allowImplicitFetchForWrite(writeStrategy)

        const resolveBase = async (): Promise<{ base: PartialWithId<T>; hydrate?: PartialWithId<T> }> => {
            const cached = jotaiStore.get(atom).get(id) as T | undefined
            if (cached) {
                return { base: cached as unknown as PartialWithId<T> }
            }

            if (!allowImplicitFetchForWrite) {
                throw new Error(`[Atoma] updateOne: 缓存缺失且当前写入模式禁止补读，请先 fetch 再 update（id=${String(id)}）`)
            }

            const { data } = await clientRuntime.io.query(handle, {
                filter: { op: 'eq', field: 'id', value: id },
                page: { mode: 'offset', limit: 1, offset: 0, includeTotal: false }
            }, observabilityContext)
            const one = data[0]
            const fetched = one !== undefined ? (one as T) : undefined
            if (!fetched) {
                throw new Error(`Item with id ${id} not found`)
            }

            const processed = await clientRuntime.dataProcessor.writeback(handle, fetched, options?.opContext)
            if (!processed) {
                throw new Error(`Item with id ${id} not found`)
            }
            return {
                base: processed as unknown as PartialWithId<T>,
                hydrate: processed as unknown as PartialWithId<T>
            }
        }

        const { base, hydrate } = await resolveBase()

        const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
        const patched = { ...(next as any), id } as PartialWithId<T>
        const validObj = await storeWriteEngine.prepareForUpdate<T>(clientRuntime, handle, base, patched, options?.opContext)

        const { ticket } = clientRuntime.mutation.api.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            if (hydrate) {
                storeWriteEngine.dispatch<T>(clientRuntime, {
                    type: 'hydrate',
                    handle,
                    data: hydrate,
                    opContext: options?.opContext,
                    writeStrategy
                })
            }

            storeWriteEngine.dispatch<T>(clientRuntime, {
                type: 'update',
                handle,
                data: validObj,
                opContext: options?.opContext,
                ticket,
                writeStrategy,
                onSuccess: async updated => {
                    await storeWriteEngine.runAfterSave(hooks, validObj, 'update')
                    resolve(updated)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to update item with id ${id}`))
                }
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            storeWriteEngine.ignoreTicketRejections(ticket)
            return resultPromise
        }

        await Promise.all([
            resultPromise,
            clientRuntime.mutation.api.awaitTicket(ticket, options)
        ])

        return resultPromise
    }
}
