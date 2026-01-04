import type { ObservabilityContext } from '#observability'
import type { Entity, OperationContext, PatchMetadata, PersistWriteback, StoreDispatchEvent, StoreHandle } from '../types'
import type { Plan } from './pipeline/types'

export type Unsubscribe = () => void

export type Observer<T> = (payload: T) => void | Promise<void>

export class HookEvent<T> {
    private readonly listeners = new Set<Observer<T>>()

    on(listener: Observer<T>): Unsubscribe {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    async emit(payload: T): Promise<void> {
        for (const listener of this.listeners) {
            try {
                await listener(payload)
            } catch {
                // observer 默认错误隔离
            }
        }
    }
}

export type Middleware<Ctx, Res> = (ctx: Ctx, next: (ctx: Ctx) => Promise<Res>) => Promise<Res>

export class HookMiddlewareChain<Ctx, Res> {
    private readonly middlewares: Middleware<Ctx, Res>[] = []

    use(middleware: Middleware<Ctx, Res>): Unsubscribe {
        this.middlewares.push(middleware)
        return () => {
            const idx = this.middlewares.indexOf(middleware)
            if (idx >= 0) this.middlewares.splice(idx, 1)
        }
    }

    async run(ctx: Ctx, base: (ctx: Ctx) => Promise<Res>): Promise<Res> {
        const stack = this.middlewares.slice()

        const dispatch = async (i: number, nextCtx: Ctx): Promise<Res> => {
            const mw = stack[i]
            if (!mw) return base(nextCtx)
            return mw(nextCtx, (c) => dispatch(i + 1, c))
        }

        return dispatch(0, ctx)
    }
}

export type Extensions = Readonly<Record<string, unknown>>

export type DispatchDecision<T = unknown> =
    | { kind: 'proceed'; extensions?: Extensions }
    | { kind: 'reject'; error: unknown; extensions?: Extensions }
    | { kind: 'transform'; event: T; extensions?: Extensions }

export type PersistMode = 'direct' | 'outbox' | 'custom'
export type PersistStatus = 'confirmed' | 'enqueued'

export type PersistResult<T extends Entity> = Readonly<{
    mode: PersistMode
    status: PersistStatus
    created?: T[]
    writeback?: PersistWriteback<T>
    extensions?: Extensions
}>

export type BeforeDispatchContext<T extends Entity> = Readonly<{
    storeName: string
    event: StoreDispatchEvent<T>
}>

export type PlannedEvent<T extends Entity> = Readonly<{
    storeName: string
    opContext?: OperationContext
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    observabilityContext: ObservabilityContext
    extensions?: Extensions
}>

export type BeforePersistContext<T extends Entity> = Readonly<{
    storeName: string
    opContext?: OperationContext
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    metadata: PatchMetadata
    observabilityContext: ObservabilityContext
}>

export type AfterPersistEvent<T extends Entity> = Readonly<{
    ctx: BeforePersistContext<T>
    result: PersistResult<T>
}>

export type PersistErrorEvent = Readonly<{
    ctx: BeforePersistContext<any>
    error: unknown
}>

export type CommittedEvent<T extends Entity> = Readonly<{
    storeName: string
    opContext?: OperationContext
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    persistResult: PersistResult<T>
    observabilityContext: ObservabilityContext
    extensions?: Extensions
}>

export type RolledBackEvent<T extends Entity> = Readonly<{
    storeName: string
    opContext?: OperationContext
    handle: StoreHandle<T>
    operations: StoreDispatchEvent<T>[]
    plan: Plan<T>
    error: unknown
    observabilityContext: ObservabilityContext
    extensions?: Extensions
}>

export type RemotePullEvent = Readonly<{
    storeName: string
    changes: unknown
    extensions?: Extensions
}>

export type RemoteAckEvent = Readonly<{
    storeName: string
    idempotencyKey?: string
    ack: unknown
    extensions?: Extensions
}>

export type RemoteRejectEvent = Readonly<{
    storeName: string
    idempotencyKey?: string
    reject: unknown
    reason?: unknown
    extensions?: Extensions
}>

export type MutationHooks = Readonly<{
    middleware: Readonly<{
        beforeDispatch: HookMiddlewareChain<BeforeDispatchContext<any>, DispatchDecision<StoreDispatchEvent<any>>>
        beforePersist: HookMiddlewareChain<BeforePersistContext<any>, PersistResult<any>>
    }>
    events: Readonly<{
        planned: HookEvent<PlannedEvent<any>>
        afterPersist: HookEvent<AfterPersistEvent<any>>
        persistError: HookEvent<PersistErrorEvent>
        committed: HookEvent<CommittedEvent<any>>
        rolledBack: HookEvent<RolledBackEvent<any>>
        remotePull: HookEvent<RemotePullEvent>
        remoteAck: HookEvent<RemoteAckEvent>
        remoteReject: HookEvent<RemoteRejectEvent>
    }>
}>

export function createMutationHooks(): MutationHooks {
    return {
        middleware: {
            beforeDispatch: new HookMiddlewareChain(),
            beforePersist: new HookMiddlewareChain()
        },
        events: {
            planned: new HookEvent(),
            afterPersist: new HookEvent(),
            persistError: new HookEvent(),
            committed: new HookEvent(),
            rolledBack: new HookEvent(),
            remotePull: new HookEvent(),
            remoteAck: new HookEvent(),
            remoteReject: new HookEvent()
        }
    }
}
