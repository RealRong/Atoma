import { createServiceToken } from '../client/services'
import type { StoreToken } from '../core'

export type PanelId = string
export type SourceId = string

export type Capability = Readonly<{
    snapshot?: boolean
    stream?: boolean
    command?: boolean
    schema?: boolean
    search?: boolean
    paginate?: boolean
}>

export type PanelSpec = Readonly<{
    id: PanelId
    title: string
    order?: number
    icon?: string
    renderer?: 'table' | 'tree' | 'timeline' | 'stats' | 'raw'
}>

export type CommandSpec = Readonly<{
    name: string
    title?: string
    argsJson?: string
}>

export type SourceSpec = Readonly<{
    id: SourceId
    clientId: string
    namespace: string
    title: string
    priority?: number
    panels: PanelSpec[]
    capability: Capability
    tags?: string[]
    commands?: CommandSpec[]
}>

export type SnapshotQuery = Readonly<{
    panelId?: PanelId
    storeName?: StoreToken
    filter?: Record<string, unknown>
    search?: string
    cursor?: string
    limit?: number
}>

export type Snapshot = Readonly<{
    version: 1
    sourceId: SourceId
    clientId: string
    panelId?: PanelId
    revision: number
    timestamp: number
    data: unknown
    page?: {
        cursor?: string
        nextCursor?: string
        totalApprox?: number
    }
    meta?: {
        title?: string
        tags?: string[]
        warnings?: string[]
    }
}>

export type StreamEventType =
    | 'source:registered'
    | 'source:unregistered'
    | 'data:changed'
    | 'timeline:event'
    | 'command:result'
    | 'error'

export type StreamEvent = Readonly<{
    version: 1
    sourceId: SourceId
    clientId: string
    panelId?: PanelId
    type: StreamEventType
    revision?: number
    timestamp: number
    payload?: unknown
}>

export type Command = Readonly<{
    sourceId: SourceId
    name: string
    args?: Record<string, unknown>
}>

export type CommandResult = Readonly<{
    ok: boolean
    message?: string
    data?: unknown
}>

export type Source = Readonly<{
    spec: SourceSpec
    snapshot?: (query?: SnapshotQuery) => Snapshot
    subscribe?: (fn: (event: StreamEvent) => void) => () => void
    invoke?: (command: Command) => CommandResult | Promise<CommandResult>
}>

export type ListArgs = Readonly<{
    clientId?: string
    panelId?: PanelId
    namespace?: string
}>

export type SubscribeArgs = Readonly<{
    clientId?: string
    sourceIds?: SourceId[]
    panelId?: PanelId
}>

export type SnapshotArgs = Readonly<{
    sourceId: SourceId
    query?: SnapshotQuery
}>

export type Hub = Readonly<{
    register: (source: Source) => () => void
    list: (args?: ListArgs) => SourceSpec[]
    snapshot: (args: SnapshotArgs) => Snapshot
    subscribe: (args: SubscribeArgs, fn: (event: StreamEvent) => void) => () => void
    invoke: (command: Command) => Promise<CommandResult>
}>

export const HUB_TOKEN = createServiceToken<Hub>('devtools.hub')
