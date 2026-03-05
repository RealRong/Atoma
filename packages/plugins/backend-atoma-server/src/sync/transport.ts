import type { SyncTransport } from '@atoma-js/types/client/sync'
import {
    HTTP_PATH_SYNC_RXDB_PULL,
    HTTP_PATH_SYNC_RXDB_PUSH,
    HTTP_PATH_SYNC_RXDB_STREAM,
    parseSyncPullResponse,
    parseSyncPushResponse
} from '@atoma-js/types/protocol-tools'
import type { AtomaServerBackendPluginOptions } from '../types'
import { postJson, resolveFetch } from './http'
import { createStream } from './stream'

export function createSyncTransport(
    options: Pick<
        AtomaServerBackendPluginOptions,
        'baseURL' | 'fetchFn' | 'headers' | 'retry' | 'onRequest' | 'onResponse' | 'syncPaths'
    >
): SyncTransport {
    const baseURL = options.baseURL
    const fetchFn = resolveFetch(options.fetchFn)
    const syncPaths = {
        pull: normalizeSyncPath(options.syncPaths?.pull, HTTP_PATH_SYNC_RXDB_PULL),
        push: normalizeSyncPath(options.syncPaths?.push, HTTP_PATH_SYNC_RXDB_PUSH),
        stream: normalizeSyncPath(options.syncPaths?.stream, HTTP_PATH_SYNC_RXDB_STREAM)
    }

    return {
        pull: async (request) => postJson({
            path: syncPaths.pull,
            request,
            baseURL,
            fetchFn,
            headers: options.headers,
            retry: options.retry,
            onRequest: options.onRequest,
            onResponse: options.onResponse,
            parser: parseSyncPullResponse
        }),
        push: async (request) => postJson({
            path: syncPaths.push,
            request,
            baseURL,
            fetchFn,
            headers: options.headers,
            retry: options.retry,
            onRequest: options.onRequest,
            onResponse: options.onResponse,
            parser: parseSyncPushResponse
        }),
        subscribe: (args) => {
            return createStream({
                baseURL,
                streamPath: syncPaths.stream,
                resource: args.resource,
                reconnectDelayMs: args.reconnectDelayMs,
                pollIntervalMs: args.pollIntervalMs,
                onNotify: args.onNotify,
                onError: args.onError
            })
        }
    }
}

function normalizeSyncPath(path: string | undefined, fallback: string): string {
    if (typeof path !== 'string') return fallback
    const normalized = path.trim()
    return normalized || fallback
}
