import type { ResourceToken } from '../protocol'

export type SyncCheckpoint = Readonly<{
    cursor: number
}>

export type SyncDocument = Readonly<{
    id: string
    version: number
    _deleted?: boolean
    [k: string]: unknown
}>

export type SyncPullRequest = Readonly<{
    resource: ResourceToken
    checkpoint?: SyncCheckpoint
    batchSize: number
}>

export type SyncPullResponse = Readonly<{
    documents: SyncDocument[]
    checkpoint: SyncCheckpoint
}>

export type SyncPushRow = Readonly<{
    newDocumentState: SyncDocument
    assumedMasterState?: SyncDocument | null
}>

export type SyncPushRequest = Readonly<{
    resource: ResourceToken
    rows: SyncPushRow[]
    context?: Readonly<{
        clientId?: string
        requestId?: string
        traceId?: string
    }>
}>

export type SyncPushResponse = Readonly<{
    conflicts: SyncDocument[]
}>

export type SyncStreamNotify = Readonly<{
    resource?: ResourceToken
    cursor?: number
}>
