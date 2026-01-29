import type { CoreRuntime, PersistWriteback, StoreToken } from '#core'
import type { OperationContext } from '#core'
import type { ObservabilityContext } from '#observability'
import type { EntityId } from '#protocol'
import type { Patch } from 'immer'
import { StoreHandleResolver } from '../../../internal/StoreHandleResolver'
import { WritebackMirror } from './WritebackMirror'

export class ClientRuntimeInternalEngine {
    private readonly handleResolver: StoreHandleResolver
    private readonly writebackMirror?: WritebackMirror

    constructor(
        private readonly runtime: CoreRuntime,
        opts?: Readonly<{
            mirrorWritebackToStore?: boolean
            now?: () => number
        }>
    ) {
        this.handleResolver = new StoreHandleResolver(this.runtime)
        if (opts?.mirrorWritebackToStore) {
            this.writebackMirror = new WritebackMirror(this.runtime, this.handleResolver, { now: opts?.now })
        }
    }

    getStoreSnapshot = (storeName: string) => {
        const handle = this.handleResolver.resolve(storeName, `runtime.snapshot:${String(storeName)}`)
        return handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, any>
    }

    applyWriteback = async (storeName: string, args: PersistWriteback<any>) => {
        const handle = this.handleResolver.resolve(storeName, `runtime.applyWriteback:${String(storeName)}`)
        await this.runtime.storeWrite.applyWriteback(handle, args)
    }

    dispatchPatches = (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => {
        const storeName = String(args.storeName)
        const handle = this.handleResolver.resolve(storeName, `runtime.dispatchPatches:${storeName}`)
        return new Promise<void>((resolve, reject) => {
            this.runtime.storeWrite.dispatch({
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
