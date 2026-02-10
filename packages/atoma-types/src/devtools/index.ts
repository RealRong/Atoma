import { defineCapability } from '../client/registry'

export type DebugKind = 'store' | 'index' | 'sync' | 'history' | 'trace' | 'custom'

export type DebugProviderSnapshotArgs = Readonly<{
    storeName?: string
}>

export type DebugSnapshotArgs = Readonly<{
    kind?: DebugKind
    clientId?: string
    storeName?: string
}>

export type DebugPayload = Readonly<{
    version: 1
    providerId: string
    kind: DebugKind
    clientId: string
    timestamp: number
    scope?: {
        storeName?: string
        tab?: string
    }
    data: unknown
    meta?: {
        title?: string
        tags?: string[]
        capabilities?: string[]
    }
}>

export type DebugProvider = Readonly<{
    id: string
    kind: DebugKind
    clientId: string
    priority?: number
    snapshot: (args?: DebugProviderSnapshotArgs) => DebugPayload
}>

export type DebugHubEvent = Readonly<{
    type: 'register' | 'unregister'
    providerId: string
    kind: DebugKind
    clientId: string
}>

export type DebugHub = Readonly<{
    register: (provider: DebugProvider) => () => void
    get: (providerId: string) => DebugProvider | undefined
    list: (filter?: { kind?: DebugKind; clientId?: string }) => DebugProvider[]
    snapshotAll: (args?: DebugSnapshotArgs) => DebugPayload[]
    subscribe: (fn: (e: DebugHubEvent) => void) => () => void
}>

export const DEBUG_HUB_CAPABILITY = defineCapability<DebugHub>('debug.hub')
