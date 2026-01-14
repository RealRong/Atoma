import { produce } from 'immer'
import type { Draft } from 'immer'
import type { Entity, PartialWithId, StoreHandle, StoreOperationOptions } from '../../types'
import type { EntityId } from '#protocol'
import { dispatch } from '../internals/dispatch'
import { runAfterSave } from '../internals/hooks'
import { resolveObservabilityContext } from '../internals/runtime'
import { ignoreTicketRejections } from '../internals/tickets'
import { validateWithSchema } from '../internals/validation'
import { prepareForUpdate } from '../internals/writePipeline'
import type { StoreWriteConfig } from '../internals/writeConfig'
import { executeQuery } from '../internals/opsExecutor'

export function createUpdateOne<T extends Entity>(handle: StoreHandle<T>, writeConfig: StoreWriteConfig) {
    const { jotaiStore, atom, services, hooks, schema, transform } = handle
    return async (id: EntityId, recipe: (draft: Draft<T>) => void, options?: StoreOperationOptions) => {
        const observabilityContext = resolveObservabilityContext(handle, options)

        const resolveBase = async (): Promise<{ base: PartialWithId<T>; hydrate?: PartialWithId<T> }> => {
            const cached = jotaiStore.get(atom).get(id) as T | undefined
            if (cached) {
                return { base: cached as unknown as PartialWithId<T> }
            }

            if (!writeConfig.allowImplicitFetchForWrite) {
                throw new Error(`[Atoma] updateOne: 缓存缺失且当前写入模式禁止补读，请先 fetch 再 update（id=${String(id)}）`)
            }

            const { data } = await executeQuery(handle, { where: { id }, limit: 1, includeTotal: false } as any, observabilityContext)
            const one = data[0]
            const fetched = one !== undefined ? (one as T) : undefined
            if (!fetched) {
                throw new Error(`Item with id ${id} not found`)
            }

            const transformed = transform(fetched)
            const validFetched = await validateWithSchema(transformed, schema)
            return {
                base: validFetched as unknown as PartialWithId<T>,
                hydrate: validFetched as unknown as PartialWithId<T>
            }
        }

        const { base, hydrate } = await resolveBase()

        const next = produce(base as any, (draft: Draft<T>) => recipe(draft)) as any
        const patched = { ...(next as any), id } as PartialWithId<T>
        const validObj = await prepareForUpdate<T>(handle, base, patched)

        const { ticket } = services.mutation.runtime.beginWrite()

        const resultPromise = new Promise<T>((resolve, reject) => {
            if (hydrate) {
                dispatch<T>({
                    type: 'hydrate',
                    handle,
                    data: hydrate,
                    opContext: options?.opContext,
                    persist: writeConfig.persistMode
                })
            }

            dispatch<T>({
                type: 'update',
                handle,
                data: validObj,
                opContext: options?.opContext,
                ticket,
                persist: writeConfig.persistMode,
                onSuccess: async updated => {
                    await runAfterSave(hooks, validObj, 'update')
                    resolve(updated)
                },
                onFail: (error) => {
                    reject(error || new Error(`Failed to update item with id ${id}`))
                }
            })
        })

        const confirmation = options?.confirmation ?? 'optimistic'
        if (confirmation === 'optimistic') {
            ignoreTicketRejections(ticket)
            return resultPromise
        }

        await Promise.all([
            resultPromise,
            services.mutation.runtime.await(ticket, options)
        ])

        return resultPromise
    }
}
