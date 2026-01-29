import type { PersistWriteback, StoreToken } from '#core'
import type { OperationContext } from '#core'
import type { ObservabilityContext } from '#observability'
import type { EntityId } from '#protocol'
import type { Patch } from 'immer'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { WritebackMirror } from './WritebackMirror'

export class ClientRuntimeInternalEngine {
    private readonly writebackMirror?: WritebackMirror

    constructor(
        private readonly runtime: ClientRuntimeInternal,
        opts?: Readonly<{
            mirrorWritebackToStore?: boolean
            now?: () => number
        }>
    ) {
        if (opts?.mirrorWritebackToStore) {
            this.writebackMirror = new WritebackMirror(this.runtime, { now: opts?.now })
        }
    }

    getStoreSnapshot = (storeName: string) => {
        const handle = this.runtime.stores.resolveHandle(storeName, `runtime.snapshot:${String(storeName)}`)
        return handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, any>
    }

    applyWriteback = async (storeName: string, args: PersistWriteback<any>) => {
        const handle = this.runtime.stores.resolveHandle(storeName, `runtime.applyWriteback:${String(storeName)}`)
        await this.runtime.write.applyWriteback(handle, args)
    }

    dispatchPatches = (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        const storeName = String(args.storeName)
        const handle = this.runtime.stores.resolveHandle(storeName, `runtime.dispatchPatches:${storeName}`)
        return new Promise<void>((resolve, reject) => {
            this.runtime.write.dispatch({
                type: 'patches',
                patches: args.patches,
                inversePatches: args.inversePatches,
                handle,
                opContext: args.opContext,
                onSuccess: resolve,
                onFail: (error?: Error) => reject(error ?? new Error('[Atoma] runtime: patches 写入失败'))
            } as any)
        })
    }

    commitWriteback = async (
        storeName: StoreToken,
        writeback: PersistWriteback<any>,
        options?: { context?: ObservabilityContext }
    ) => {
        const name = String(storeName)
        await this.applyWriteback(name, writeback)

        // Only mirror into the durable store backend when Store is configured as durable.
        if (!this.writebackMirror) return
        await this.writebackMirror.commit(name, writeback, options)
    }
}
