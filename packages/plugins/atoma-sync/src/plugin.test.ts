import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_TRANSPORT_TOKEN, type SyncTransport } from 'atoma-types/client/sync'
import { syncPlugin } from './plugin'
import { createReadyRuntime } from './rxdb/database'

vi.mock('./rxdb/database', () => {
    return {
        createReadyRuntime: vi.fn()
    }
})

const mockedCreateReadyRuntime = vi.mocked(createReadyRuntime)

type WriteCommittedEvent = Readonly<{
    storeName: string
    context?: Readonly<{ origin?: string }>
    changes?: ReadonlyArray<unknown>
}>

function createPluginContext(args: {
    onWriteCommitted: (listener: (event: WriteCommittedEvent) => void) => void
    syncTransport: SyncTransport
}) {
    return {
        clientId: 'client-1',
        services: {
            register: vi.fn(),
            resolve: vi.fn((token: unknown) => {
                return token === SYNC_TRANSPORT_TOKEN
                    ? args.syncTransport
                    : undefined
            })
        },
        runtime: {
            id: 'runtime-1',
            now: () => Date.now(),
            stores: {
                list: () => [],
                use: vi.fn(),
                peek: vi.fn(),
                snapshot: vi.fn()
            },
            action: {
                createContext: vi.fn()
            },
            execution: {
                register: vi.fn(),
                hasExecutor: vi.fn()
            }
        },
        events: {
            on: vi.fn((name: string, listener: (event: WriteCommittedEvent) => void) => {
                if (name === 'writeCommitted') {
                    args.onWriteCommitted(listener)
                }
                return () => {}
            }),
            off: vi.fn(),
            once: vi.fn(() => {
                return () => {}
            })
        }
    } as any
}

async function waitMicrotask(): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
    })
}

describe('syncPlugin local bridge', () => {
    beforeEach(() => {
        mockedCreateReadyRuntime.mockReset()
    })

    it('writeCommitted 应写入 RxDB collection', async () => {
        let writeCommittedListener: ((event: WriteCommittedEvent) => void) | null = null
        const collection = {
            bulkUpsert: vi.fn(async () => ({ error: [] }))
        }
        const resource = {
            resource: 'users',
            storeName: 'users',
            collectionName: 'users',
            schema: {} as any
        }

        mockedCreateReadyRuntime.mockResolvedValue({
            database: {
                close: vi.fn(async () => {})
            },
            resources: [resource],
            resourceByStoreName: new Map([['users', resource]]),
            collectionByResource: new Map([['users', collection as any]])
        } as any)

        const ctx = createPluginContext({
            syncTransport: {
                pull: vi.fn(async () => ({ documents: [], checkpoint: { cursor: 0 } })),
                push: vi.fn(async () => ({ conflicts: [] }))
            },
            onWriteCommitted: (listener) => {
                writeCommittedListener = listener
            }
        })

        const plugin = syncPlugin({
            resources: ['users']
        })
        plugin.setup?.(ctx)

        writeCommittedListener?.({
            storeName: 'users',
            context: { origin: 'client' },
            changes: [
                {
                    id: 'u1',
                    before: { id: 'u1', version: 1, name: 'old' },
                    after: { id: 'u1', version: 2, name: 'new' }
                }
            ]
        })
        await waitMicrotask()

        expect(collection.bulkUpsert).toHaveBeenCalledTimes(1)
        const docs = collection.bulkUpsert.mock.calls[0]?.[0] as Array<Record<string, unknown>>
        expect(docs).toHaveLength(1)
        expect(docs[0]).toMatchObject({
            id: 'u1',
            version: 2,
            _deleted: false,
            atomaSync: {
                resource: 'users',
                source: 'local',
                clientId: 'client-1'
            }
        })
        expect(String(docs[0].atomaSync && (docs[0].atomaSync as any).idempotencyKey)).toBeTruthy()
        expect(typeof (docs[0].atomaSync as any).changedAtMs).toBe('number')
    })

    it('writeCommitted 来源为 sync 时应跳过本地桥接', async () => {
        let writeCommittedListener: ((event: WriteCommittedEvent) => void) | null = null
        const collection = {
            bulkUpsert: vi.fn(async () => ({ error: [] }))
        }
        const resource = {
            resource: 'users',
            storeName: 'users',
            collectionName: 'users',
            schema: {} as any
        }

        mockedCreateReadyRuntime.mockResolvedValue({
            database: {
                close: vi.fn(async () => {})
            },
            resources: [resource],
            resourceByStoreName: new Map([['users', resource]]),
            collectionByResource: new Map([['users', collection as any]])
        } as any)

        const ctx = createPluginContext({
            syncTransport: {
                pull: vi.fn(async () => ({ documents: [], checkpoint: { cursor: 0 } })),
                push: vi.fn(async () => ({ conflicts: [] }))
            },
            onWriteCommitted: (listener) => {
                writeCommittedListener = listener
            }
        })

        const plugin = syncPlugin({
            resources: ['users']
        })
        plugin.setup?.(ctx)

        writeCommittedListener?.({
            storeName: 'users',
            context: { origin: 'sync' },
            changes: [
                {
                    id: 'u1',
                    before: { id: 'u1', version: 1 },
                    after: { id: 'u1', version: 2 }
                }
            ]
        })
        await waitMicrotask()

        expect(mockedCreateReadyRuntime).toHaveBeenCalledTimes(0)
        expect(collection.bulkUpsert).toHaveBeenCalledTimes(0)
    })
})
