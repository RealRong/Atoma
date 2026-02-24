import { bench, beforeAll, describe } from 'vitest'
import { Runtime } from '../packages/atoma-runtime/src/runtime/Runtime'

type BenchEntity = {
    id: string
    score: number
    flag: boolean
    label: string
}

const BENCH_TIME_MS = 700

const createItems = ({
    count,
    start = 0,
    version = 0
}: {
    count: number
    start?: number
    version?: number
}): BenchEntity[] => {
    const items = new Array<BenchEntity>(count)
    for (let index = 0; index < count; index += 1) {
        const serial = start + index
        items[index] = {
            id: `id-${serial}`,
            score: serial + version,
            flag: ((serial + version) & 1) === 0,
            label: `label-${serial}-${version}`
        }
    }
    return items
}

const duplicateIds = (items: ReadonlyArray<BenchEntity>, times: number): string[] => {
    const ids: string[] = []
    for (let turn = 0; turn < times; turn += 1) {
        items.forEach((item) => {
            ids.push(item.id)
        })
    }
    return ids
}

describe('runtime/catalog.reconcile baseline', () => {
    const DATA_SIZE = 5000
    const datasetA = createItems({ count: DATA_SIZE, version: 1 })
    const datasetB = createItems({ count: DATA_SIZE, version: 2 })
    const removeIds = datasetA
        .filter((_item, index) => (index & 1) === 0)
        .map((item) => item.id)
    const restoreItems = datasetA.filter((_item, index) => (index & 1) === 0)

    const runtime = new Runtime({
        id: 'bench-catalog-reconcile',
        stores: {
            schema: {
                users: {}
            }
        }
    })
    runtime.stores.ensure<BenchEntity>('users')
    const session = runtime.stores.use<BenchEntity>('users')

    let toggle = false

    beforeAll(async () => {
        await session.reconcile({
            mode: 'replace',
            items: datasetA
        })
    })

    bench('reconcile.replace(5000)', async () => {
        toggle = !toggle
        await session.reconcile({
            mode: 'replace',
            items: toggle ? datasetA : datasetB
        })
    }, { time: BENCH_TIME_MS })

    bench('reconcile.upsert(5000)', async () => {
        toggle = !toggle
        await session.reconcile({
            mode: 'upsert',
            items: toggle ? datasetA : datasetB
        })
    }, { time: BENCH_TIME_MS })

    bench('reconcile.remove(2500)+restore(2500)', async () => {
        await session.reconcile({
            mode: 'remove',
            ids: removeIds
        })
        await session.reconcile({
            mode: 'upsert',
            items: restoreItems
        })
    }, { time: BENCH_TIME_MS })
})

describe('runtime/readflow baseline', () => {
    const DATA_SIZE = 5000
    const datasetA = createItems({ count: DATA_SIZE, version: 3 })
    const datasetB = createItems({ count: DATA_SIZE, version: 4 })
    const lookupIds = duplicateIds(datasetA.slice(0, 1000), 3)

    const localRuntime = new Runtime({
        id: 'bench-read-local',
        stores: {
            schema: {
                users: {}
            }
        }
    })
    const localStore = localRuntime.stores.ensure<BenchEntity>('users')
    const localSession = localRuntime.stores.use<BenchEntity>('users')

    const remoteRuntime = new Runtime({
        id: 'bench-read-remote',
        stores: {
            schema: {
                users: {}
            }
        }
    })
    const remoteStore = remoteRuntime.stores.ensure<BenchEntity>('users')

    let remoteToggle = false
    remoteRuntime.execution.register({
        id: 'bench-query',
        query: async () => {
            remoteToggle = !remoteToggle
            return {
                source: 'remote',
                data: remoteToggle ? datasetA : datasetB
            }
        }
    })

    beforeAll(async () => {
        await localSession.reconcile({
            mode: 'replace',
            items: datasetA
        })
    })

    bench('read.getMany local(3000 ids with duplicates)', async () => {
        await localStore.getMany(lookupIds)
    }, { time: BENCH_TIME_MS })

    bench('read.list remote->replace(5000)', async () => {
        await remoteStore.list()
    }, { time: BENCH_TIME_MS })
})

describe('runtime/writeflow baseline', () => {
    const BATCH_SIZE = 1200
    const batchA = createItems({ count: BATCH_SIZE, version: 5 })
    const batchB = createItems({ count: BATCH_SIZE, version: 6 })

    const localRuntime = new Runtime({
        id: 'bench-write-local',
        stores: {
            schema: {
                users: {}
            }
        }
    })
    const localStore = localRuntime.stores.ensure<BenchEntity>('users')
    const localSession = localRuntime.stores.use<BenchEntity>('users')

    const remoteRuntime = new Runtime({
        id: 'bench-write-remote',
        stores: {
            schema: {
                users: {}
            }
        }
    })
    remoteRuntime.execution.register({
        id: 'bench-write',
        write: async ({ entries }) => ({
            status: 'confirmed',
            results: entries.map((entry) => {
                if (entry.action === 'delete') {
                    return {
                        ok: true as const,
                        id: entry.item.id
                    }
                }
                return {
                    ok: true as const,
                    id: entry.item.id,
                    data: entry.item.value
                }
            })
        })
    })
    const remoteStore = remoteRuntime.stores.ensure<BenchEntity>('users')
    const remoteSession = remoteRuntime.stores.use<BenchEntity>('users')

    let localToggle = false
    let remoteToggle = false

    beforeAll(async () => {
        await localSession.reconcile({
            mode: 'replace',
            items: batchA
        })
        await remoteSession.reconcile({
            mode: 'replace',
            items: batchA
        })
    })

    bench('write.upsertMany local optimistic(1200)', async () => {
        localToggle = !localToggle
        await localStore.upsertMany(localToggle ? batchA : batchB)
    }, { time: BENCH_TIME_MS })

    bench('write.upsertMany remote optimistic+reconcile(1200)', async () => {
        remoteToggle = !remoteToggle
        await remoteStore.upsertMany(remoteToggle ? batchA : batchB)
    }, { time: BENCH_TIME_MS })
})
