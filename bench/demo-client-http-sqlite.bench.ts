import { bench, describe } from 'vitest'
import { createHttpDemoClient, createMemoryDemoClient, type DemoClient } from '../tests/noUiSystem/support/createDemoClient'
import { createDemoSeed, type DemoUser } from '../tests/noUiSystem/support/demoSchema'
import { createSqliteDemoServer, type SqliteDemoServer } from '../tests/noUiSystem/support/createSqliteDemoServer'

const resolvedBenchTime = Number(process.env.ATOMA_DEMO_BENCH_TIME_MS ?? 700)
const BENCH_TIME_MS = Number.isFinite(resolvedBenchTime) && resolvedBenchTime > 0
    ? Math.floor(resolvedBenchTime)
    : 700

function createBenchUsers(args: {
    start: number
    count: number
}): DemoUser[] {
    const out: DemoUser[] = []
    for (let index = 0; index < args.count; index += 1) {
        const serial = args.start + index
        out.push({
            id: `u-bench-${serial}`,
            name: `Bench-${serial}`,
            age: 18 + (serial % 40),
            region: serial % 2 === 0 ? 'EU' : 'US'
        })
    }
    return out
}

const memoryClient = createMemoryDemoClient({
    seed: createDemoSeed(),
    enableHistory: false,
    enableSync: false
})

type HttpSuite = {
    server: SqliteDemoServer
    writer: DemoClient
    replica: DemoClient
}

let httpSuitePromise: Promise<HttpSuite> | null = null

async function ensureHttpSuite(): Promise<HttpSuite> {
    if (httpSuitePromise) return await httpSuitePromise

    httpSuitePromise = (async () => {
        const server = await createSqliteDemoServer({ mode: 'in-process' })

        const writer = createHttpDemoClient({
            baseURL: server.baseURL,
            fetchFn: server.request,
            enableHistory: false,
            enableSync: false
        })

        const replica = createHttpDemoClient({
            baseURL: server.baseURL,
            fetchFn: server.request,
            enableHistory: false,
            enableSync: true,
            syncMode: 'pull-only',
            subscribe: false,
            syncClientKey: `bench-replica-${Date.now()}`
        })

        await writer.stores('users').createMany(createDemoSeed().users)
        return { server, writer, replica }
    })()

    return await httpSuitePromise
}

let disposed = false
async function disposeBenchResources(): Promise<void> {
    if (disposed) return
    disposed = true

    try {
        memoryClient.dispose()
    } catch {
        // ignore
    }

    if (!httpSuitePromise) return
    try {
        const suite = await httpSuitePromise
        suite.writer.dispose()
        suite.replica.dispose()
        await suite.server.close()
    } catch {
        // ignore
    }
}

process.once('beforeExit', () => {
    void disposeBenchResources()
})

describe('demo/memory client baseline', () => {
    let writeTurn = 0

    bench('users.upsertMany(400) memory', async () => {
        writeTurn += 1
        await memoryClient.stores('users').upsertMany(createBenchUsers({
            start: writeTurn * 1000,
            count: 400
        }))
    }, { time: BENCH_TIME_MS })

    bench('users.query(region=EU,age>=30) memory', async () => {
        await memoryClient.stores('users').query({
            filter: {
                op: 'and',
                args: [
                    { op: 'eq', field: 'region', value: 'EU' },
                    { op: 'gte', field: 'age', value: 30 }
                ]
            },
            sort: [{ field: 'age', dir: 'asc' }],
            page: { mode: 'offset', limit: 100, offset: 0 }
        })
    }, { time: BENCH_TIME_MS })
})

describe('demo/http+sqlite client baseline', () => {
    let writeTurn = 0
    let syncTurn = 0

    bench('users.upsertMany(250) http+sqlite', async () => {
        const suite = await ensureHttpSuite()
        writeTurn += 1
        await suite.writer.stores('users').upsertMany(createBenchUsers({
            start: writeTurn * 10_000,
            count: 250
        }))
    }, { time: BENCH_TIME_MS })

    bench('users.query(region=US,age>=25) http+sqlite', async () => {
        const suite = await ensureHttpSuite()
        await suite.writer.stores('users').query({
            filter: {
                op: 'and',
                args: [
                    { op: 'eq', field: 'region', value: 'US' },
                    { op: 'gte', field: 'age', value: 25 }
                ]
            },
            sort: [{ field: 'age', dir: 'desc' }],
            page: { mode: 'offset', limit: 100, offset: 0 }
        })
    }, { time: BENCH_TIME_MS })

    bench('sync.pull(one remote write) http+sqlite', async () => {
        const suite = await ensureHttpSuite()
        syncTurn += 1
        await suite.writer.stores('users').upsert({
            id: `u-sync-bench-${syncTurn}`,
            name: `SyncBench-${syncTurn}`,
            age: 30 + (syncTurn % 5),
            region: 'CN'
        })
        await suite.replica.sync?.pull()
    }, { time: BENCH_TIME_MS })
})
