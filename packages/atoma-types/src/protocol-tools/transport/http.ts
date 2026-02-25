export const HTTP_PATH_OPS = '/ops'
export const HTTP_PATH_SYNC_RXDB_PULL = '/sync/rxdb/pull'
export const HTTP_PATH_SYNC_RXDB_PUSH = '/sync/rxdb/push'
export const HTTP_PATH_SYNC_RXDB_STREAM = '/sync/rxdb/stream'

export const http = {
    paths: {
        OPS: HTTP_PATH_OPS,
        SYNC_RXDB_PULL: HTTP_PATH_SYNC_RXDB_PULL,
        SYNC_RXDB_PUSH: HTTP_PATH_SYNC_RXDB_PUSH,
        SYNC_RXDB_STREAM: HTTP_PATH_SYNC_RXDB_STREAM
    }
} as const
