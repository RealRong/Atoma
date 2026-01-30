import type { OperationContext, PersistWriteback } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { Patch } from 'immer'
import type { ClientRuntimeInternal } from '#client/internal/types'

export class ClientRuntimeInternalEngine {
    constructor(
        private readonly runtime: ClientRuntimeInternal
    ) {
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

}
