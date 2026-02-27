import type { BackendPluginOptions } from 'atoma-backend-http'

export type AtomaServerSyncPaths = Readonly<{
    pull?: string
    push?: string
    stream?: string
}>

export type AtomaServerBackendPluginOptions = BackendPluginOptions & Readonly<{
    syncPaths?: AtomaServerSyncPaths
}>
