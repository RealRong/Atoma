import type { Runtime, HookRegistry } from '../../runtime'
import type { RemoteOpEnvelope, RemoteOpResultEnvelope } from '../ops'
import type { CapabilitiesRegistry } from '../registry'

export type Next<T> = () => Promise<T>

export type OpsContext = {
    clientId: string
}

export type OpsHandler = (
    req: RemoteOpEnvelope,
    ctx: OpsContext,
    next: Next<RemoteOpResultEnvelope>
) => Promise<RemoteOpResultEnvelope>

export type OpsEntry = {
    handler: OpsHandler
    priority: number
}

export type OpsRegister = (
    handler: OpsHandler,
    opts?: { priority?: number }
) => () => void

export type PluginInitResult<Ext = unknown> = Readonly<{
    extension?: Ext
    dispose?: () => void
}>

export type ClientPlugin<Ext = unknown> = Readonly<{
    id?: string
    register?: (ctx: PluginContext, register: OpsRegister) => void
    init?: (ctx: PluginContext) => void | PluginInitResult<Ext>
}>

export type PluginContext = Readonly<{
    clientId: string
    capabilities: CapabilitiesRegistry
    runtime: Runtime
    hooks: HookRegistry
}>
