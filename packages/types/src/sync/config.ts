export type SyncMode = 'full' | 'pull-only' | 'push-only'

export type SyncStatus = Readonly<{
    started: boolean
    configured: boolean
    active?: boolean
}>
