import type { StoreToken } from '#core'
import type { ClientRuntimeInternal } from '#client/internal/types'
import type { ChannelApi, ClientIo, ClientPluginContext, RemoteApi } from '#client/types'
import type { DevtoolsRegistry } from './DevtoolsRegistry'

export class PluginContext {
    readonly context: ClientPluginContext

    constructor(args: {
        client: unknown
        runtime: ClientRuntimeInternal
        clientKey: string
        io: ClientIo
        store: ChannelApi
        remote: RemoteApi
        devtools: DevtoolsRegistry
        onDispose: (fn: () => void) => () => void
    }) {
        this.context = {
            core: {
                client: args.client,
                runtime: args.runtime,
                meta: {
                    clientKey: args.clientKey
                }
            },
            onDispose: args.onDispose,
            transport: {
                io: args.io,
                store: args.store,
                remote: args.remote
            },
            commit: {
                subscribe: (listener) => args.runtime.mutation.subscribeCommit(listener),
                applyPatches: (applyArgs) => args.runtime.internal.dispatchPatches({
                    storeName: String(applyArgs.storeName as StoreToken),
                    patches: applyArgs.patches,
                    inversePatches: applyArgs.inversePatches,
                    opContext: applyArgs.opContext
                })
            },
            observability: args.runtime.observability,
            persistence: {
                register: args.runtime.persistenceRouter.register,
                ack: args.runtime.mutation.acks.ack,
                reject: args.runtime.mutation.acks.reject,
                writeback: (storeName, writeback, options) => args.runtime.internal.commitWriteback(storeName as any, writeback as any, options as any)
            },
            devtools: {
                register: args.devtools.register
            }
        }
    }
}
