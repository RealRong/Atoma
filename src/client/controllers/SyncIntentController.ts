import { OutboxPersister, type BeforePersistContext, type PersistResult } from '#core'
import type { SyncClient } from '#sync'
import type { AtomaClientSyncConfig, ClientRuntime } from '../types'

export function createSyncIntentController(args: {
    runtime: ClientRuntime
    syncConfig?: AtomaClientSyncConfig
    ensureSyncEngine: (args?: { mode?: 'enqueue-only' }) => SyncClient
}): Readonly<{
    dispose: () => void
}> {
    const syncConfig = args.syncConfig
    const middlewareByStoreName = new Map<string, () => void>()

    async function persistOrNext(
        ctx: BeforePersistContext<any>,
        next: (ctx: BeforePersistContext<any>) => Promise<PersistResult<any>>
    ): Promise<PersistResult<any>> {
        const ops = Array.isArray(ctx.operations) ? ctx.operations : []
        const persistModeSet = new Set<string>()
        for (const op of ops) {
            const mode = (op as any)?.__persist
            if (mode === 'outbox' || mode === 'direct') {
                persistModeSet.add(mode)
            }
        }

        // 默认 direct：不做任何拦截
        if (!persistModeSet.size || (persistModeSet.size === 1 && persistModeSet.has('direct'))) {
            return next(ctx)
        }

        if (persistModeSet.size > 1) {
            throw new Error('[Atoma] mixed persist modes in one mutation segment (direct vs outbox)')
        }

        // createServerAssigned* 使用 type='create'，且内部强制 __persist='direct'
        // outbox 模式下禁止 server-assigned create（难以保证幂等/回放一致性）
        const types = ctx?.plan?.operationTypes
        if (Array.isArray(types) && types.includes('create' as any)) {
            throw new Error('[Atoma] createServerAssigned* 不支持 outbox（Server-ID create 必须 direct + strict，且禁止 outbox）')
        }

        const queueWriteMode = (syncConfig && typeof syncConfig === 'object' && !Array.isArray(syncConfig) && typeof (syncConfig as any).queueWriteMode === 'string')
            ? String((syncConfig as any).queueWriteMode)
            : 'intent-only'

        let localPersist: PersistResult<any> | undefined
        if (queueWriteMode === 'local-first') {
            localPersist = await next(ctx)
        }

        const engine = args.ensureSyncEngine({ mode: 'enqueue-only' })
        const outbox = new OutboxPersister(engine)
        await outbox.persist({
            handle: ctx.handle,
            operations: ctx.operations,
            plan: ctx.plan,
            metadata: ctx.metadata,
            observabilityContext: ctx.observabilityContext
        })
        return {
            mode: 'outbox',
            status: 'enqueued',
            ...(localPersist?.writeback ? { writeback: localPersist.writeback } : {}),
            ...(localPersist?.created ? { created: localPersist.created } : {})
        }
    }

    function installBeforePersist(handle: any): void {
        const storeName = String(handle.storeName || 'store')
        if (middlewareByStoreName.has(storeName)) return
        const unsub = handle.services.mutation.hooks.middleware.beforePersist.use(persistOrNext)
        middlewareByStoreName.set(storeName, unsub)
    }

    const unsubscribeHandles = args.runtime.onHandleCreated((handle) => {
        installBeforePersist(handle as any)
    }, { replay: true })

    const dispose = () => {
        unsubscribeHandles()
        for (const unsub of middlewareByStoreName.values()) {
            try {
                unsub()
            } catch {
                // ignore
            }
        }
    }

    return {
        dispose
    }
}
