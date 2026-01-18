import { defaultSnowflakeGenerator } from './idGenerator'
import { createActionId } from '../../operationContext'
import type { Entity, OperationContext, PartialWithId, WriteTicket } from '../../types'
import type { EntityId } from '#protocol'
import { runBeforeSave } from './hooks'
import { validateWithSchema } from './validation'
import type { StoreHandle } from './handleTypes'

export type StoreWriteConfig = Readonly<{
    persistMode: 'direct' | 'outbox'
    allowImplicitFetchForWrite: boolean
}>

function initBaseObject<T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> {
    const generator = idGenerator || defaultSnowflakeGenerator
    const now = Date.now()
    return {
        ...(obj as any),
        id: (obj as any).id || generator(),
        updatedAt: now,
        createdAt: now
    } as PartialWithId<T>
}

export async function prepareForAdd<T extends Entity>(
    runtime: StoreHandle<T>,
    item: Partial<T>
): Promise<PartialWithId<T>> {
    let initedObj = initBaseObject<T>(item, runtime.idGenerator) as unknown as PartialWithId<T>
    initedObj = await runBeforeSave(runtime.hooks, initedObj, 'add')
    initedObj = runtime.transform(initedObj as T) as unknown as PartialWithId<T>
    initedObj = await validateWithSchema(initedObj as T, runtime.schema) as unknown as PartialWithId<T>
    return initedObj
}

export async function prepareForUpdate<T extends Entity>(
    runtime: StoreHandle<T>,
    base: PartialWithId<T>,
    patch: PartialWithId<T>
): Promise<PartialWithId<T>> {
    let merged = Object.assign({}, base, patch, {
        updatedAt: Date.now(),
        createdAt: (base as any).createdAt ?? Date.now(),
        id: patch.id
    }) as PartialWithId<T>

    merged = await runBeforeSave(runtime.hooks, merged, 'update')
    merged = runtime.transform(merged as T) as unknown as PartialWithId<T>
    merged = await validateWithSchema(merged as T, runtime.schema) as unknown as PartialWithId<T>
    return merged
}

export function ignoreTicketRejections(ticket: WriteTicket) {
    void ticket.enqueued.catch(() => {
        // avoid unhandled rejection when optimistic writes never await enqueued
    })
    void ticket.confirmed.catch(() => {
        // avoid unhandled rejection when optimistic writes never await confirmed
    })
}

export function ensureActionId(opContext: OperationContext | undefined): OperationContext | undefined {
    if (!opContext) {
        return {
            scope: 'default',
            origin: 'user',
            actionId: createActionId()
        }
    }
    if (typeof opContext.actionId === 'string' && opContext.actionId) return opContext
    return {
        ...opContext,
        actionId: createActionId()
    }
}
