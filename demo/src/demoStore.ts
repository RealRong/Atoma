import { createSyncStore, setHistoryCallback } from 'atoma'
import { IndexedDBAdapter } from 'atoma/adapters'
import type { IBase, StoreKey } from 'atoma'
import Dexie from 'dexie'

export type DemoTask = IBase & {
    title: string
    status: 'queued' | 'active' | 'synced' | 'shipped'
    area: 'state-core' | 'adapters' | 'indexes' | 'history' | 'offline'
    impact: number
    note?: string
}

export type HistoryEntry = {
    id: string
    adapter: string
    patches: number
    summary: string
    timestamp: number
}

const db = new Dexie('atoma-demo')
db.version(1).stores({
    tasks: 'id, status, area, impact, title, updatedAt, createdAt'
})

const tasksTable = db.table<DemoTask, StoreKey>('tasks')

export const DemoStore = createSyncStore<DemoTask>({
    name: 'demo-tasks',
    adapter: new IndexedDBAdapter(tasksTable),
    indexes: [
        { field: 'status', type: 'string' },
        { field: 'area', type: 'string' },
        { field: 'impact', type: 'number' },
        { field: 'title', type: 'text', options: { minTokenLength: 2 } }
    ],
    hooks: {
        beforeSave: ({ item }) => {
            const now = Date.now()
            return {
                ...item,
                createdAt: item.createdAt ?? now,
                updatedAt: now
            } as DemoTask
        }
    }
})

export const areas: DemoTask['area'][] = ['state-core', 'adapters', 'indexes', 'history', 'offline']
export const statusFlow: DemoTask['status'][] = ['queued', 'active', 'synced', 'shipped']

const seedItems: Array<Omit<DemoTask, keyof IBase>> = [
    {
        title: 'Atomic Jotai core, fine-grained renders',
        status: 'synced',
        area: 'state-core',
        impact: 5,
        note: 'useValue/useFindMany subscribe to exactly what you need.'
    },
    {
        title: 'Queue → Immer patches → adapter sync',
        status: 'active',
        area: 'adapters',
        impact: 4,
        note: 'Batch writes, emit patches + inverse patches for history.'
    },
    {
        title: 'Indexed queries power useFindMany',
        status: 'active',
        area: 'indexes',
        impact: 4,
        note: 'Text/number indexes + Top-K sorting keep queries fast.'
    },
    {
        title: 'Offline-ready via IndexedDB',
        status: 'queued',
        area: 'offline',
        impact: 3,
        note: 'Persist to IndexedDB, hydrate cache instantly on load.'
    },
    {
        title: 'History-ready patches',
        status: 'queued',
        area: 'history',
        impact: 3,
        note: 'Same patch stream feeds undo/redo.'
    }
]

let seeded = false

export const ensureSeedData = async () => {
    if (seeded) return
    const count = await tasksTable.count()
    if (count === 0) {
        await Promise.all(
            seedItems.map(item =>
                DemoStore.addOne({
                    ...item,
                    impact: item.impact,
                    status: item.status,
                    area: item.area
                } as DemoTask)
            )
        )
    }
    seeded = true
}

export const addTask = async (title: string, area: DemoTask['area'], impact?: number) => {
    const value = title.trim() || 'New task'
    const chosenImpact = impact ?? Math.max(1, Math.min(5, Math.round(Math.random() * 5)))
    await DemoStore.addOne({
        title: value,
        status: 'queued',
        area,
        impact: chosenImpact,
        note: 'Added from the live playground'
    } as DemoTask)
}

export const cycleStatus = async (task: DemoTask) => {
    const idx = statusFlow.indexOf(task.status)
    const next = statusFlow[(idx + 1) % statusFlow.length]
    await DemoStore.updateOne({
        id: task.id,
        status: next
    })
}

export const boostImpact = async (task: DemoTask) => {
    await DemoStore.updateOne({
        id: task.id,
        impact: Math.min(5, task.impact + 1)
    })
}

export const removeTask = async (id: StoreKey) => {
    await DemoStore.deleteOneById(id)
}

export const runBurstMutation = async () => {
    const snapshot = DemoStore.getCachedAll().slice(0, 4)
    await Promise.all(
        snapshot.map((item, idx) =>
            DemoStore.updateOne({
                id: item.id,
                note: 'Patched via queue → single adapter call',
                impact: Math.min(5, item.impact + (idx % 2 ? 2 : 1))
            })
        )
    )
}

type HistoryListener = (entries: HistoryEntry[]) => void
const historyListeners = new Set<HistoryListener>()
let historyBuffer: HistoryEntry[] = []

export const subscribeHistory = (listener: HistoryListener) => {
    historyListeners.add(listener)
    listener(historyBuffer)
    return () => historyListeners.delete(listener)
}

setHistoryCallback((patches, _inversePatches, _atom, adapter) => {
    historyBuffer = [
        {
            id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
            adapter: adapter.name,
            patches: patches.length,
            summary:
                patches
                    .map(p => `${p.op} ${p.path.join('.')}`)
                    .slice(0, 2)
                    .join(', ') || `${patches.length} patch(es)`,
            timestamp: Date.now()
        },
        ...historyBuffer
    ].slice(0, 10)

    historyListeners.forEach(fn => fn([...historyBuffer]))
})
