import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot, IndexSnapshot, QueueItem, IndexQueryPlan, HistoryEntrySummary } from 'atoma'
import type { DebugEvent } from 'atoma'
import { TabButtonRow } from './components/TabButtonRow'
import { StoreTab } from './tabs/StoreTab'
import { IndexTab } from './tabs/IndexTab'
import { QueueTab } from './tabs/QueueTab'
import { HistoryTab } from './tabs/HistoryTab'
import { TraceTab } from './tabs/TraceTab'

type StoreState = Record<string, StoreSnapshot>
type IndexState = Record<string, { indexes: IndexSnapshot[]; lastQuery?: IndexQueryPlan }>
type QueueState = Record<string, { pending: QueueItem[]; failed: QueueItem[] }>
type HistoryState = Record<string, { pointer: number; length: number; entries: HistoryEntrySummary[] }>
type TraceState = Record<string, { traceId: string; events: DebugEvent[]; lastUpdatedAt: number }>

export default function DevtoolsApp(props: { bridge?: DevtoolsBridge; defaultOpen?: boolean }) {
    const { bridge, defaultOpen } = props
    const [open, setOpen] = useState(Boolean(defaultOpen))
    const [tab, setTab] = useState<'store' | 'index' | 'queue' | 'history' | 'trace'>('store')

    const [stores, setStores] = useState<StoreState>({})
    const [indexes, setIndexes] = useState<IndexState>({})
    const [queues, setQueues] = useState<QueueState>({})
    const [histories, setHistories] = useState<HistoryState>({})
    const [traces, setTraces] = useState<TraceState>({})

    useEffect(() => {
        if (!bridge) return
        const unsub = bridge.subscribe((e: DevtoolsEvent) => {
            if (e.type === 'store-snapshot') {
                setStores(prev => ({ ...prev, [e.payload.name]: e.payload }))
                return
            }
            if (e.type === 'index-snapshot') {
                setIndexes(prev => ({ ...prev, [e.payload.name]: { indexes: e.payload.indexes, lastQuery: e.payload.lastQuery } }))
                return
            }
            if (e.type === 'queue-snapshot') {
                setQueues(prev => ({ ...prev, [e.payload.name]: { pending: e.payload.pending, failed: e.payload.failed } }))
                return
            }
            if (e.type === 'history-snapshot') {
                setHistories(prev => ({ ...prev, [e.payload.name]: { pointer: e.payload.pointer, length: e.payload.length, entries: e.payload.entries } }))
                return
            }
            if (e.type === 'debug-event') {
                const evt = e.payload as DebugEvent
                const traceId = evt.traceId
                if (!traceId) return

                setTraces(prev => {
                    const maxTraces = 50
                    const maxEventsPerTrace = 200
                    const now = Date.now()

                    const existing = prev[traceId]
                    const nextEvents = existing
                        ? [...existing.events, evt].slice(-maxEventsPerTrace)
                        : [evt]

                    let next: TraceState = {
                        ...prev,
                        [traceId]: { traceId, events: nextEvents, lastUpdatedAt: now }
                    }

                    const ids = Object.keys(next)
                    if (ids.length > maxTraces) {
                        const sorted = ids
                            .map(id => ({ id, t: next[id]?.lastUpdatedAt ?? 0 }))
                            .sort((a, b) => b.t - a.t)
                        const keep = new Set(sorted.slice(0, maxTraces).map(x => x.id))
                        next = Object.fromEntries(Object.entries(next).filter(([id]) => keep.has(id))) as TraceState
                    }

                    return next
                })
            }
        })
        return () => unsub && unsub()
    }, [bridge])

    const totalCount = useMemo(
        () => Object.values(stores).reduce((sum, s) => sum + s.count, 0),
        [stores]
    )

    const containerClassName = open
        ? 'fixed bottom-4 right-4 z-[9999] h-[70vh] w-[min(920px,calc(100vw-32px))] overflow-hidden rounded-2xl bg-white text-sm text-slate-900 antialiased shadow-[0_0_0_1px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.12)]'
        : 'fixed bottom-4 right-4 z-[9999] w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl bg-white text-sm text-slate-900 antialiased shadow-[0_0_0_1px_rgba(15,23,42,0.10),0_18px_50px_rgba(15,23,42,0.12)]'

    return (
        <div
            className={containerClassName}
        >
            <div
                className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm"
            >
                <span className="font-semibold">Atoma DevTools</span>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600">缓存：{totalCount}</span>
                    <button
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 hover:bg-slate-50"
                        onClick={() => setOpen(o => !o)}
                    >
                        {open ? '收起' : '展开'}
                    </button>
                </div>
            </div>

            {open && (
                <div className="flex h-[calc(70vh-45px)] min-h-0 flex-col gap-3 p-3">
                    <TabButtonRow tab={tab} setTab={setTab} />

                    <div className="min-h-0 flex-1 overflow-hidden">
                        {tab === 'store' && <StoreTab stores={stores} />}
                        {tab === 'index' && <IndexTab indexes={indexes} />}
                        {tab === 'queue' && <QueueTab queues={queues} />}
                        {tab === 'history' && <HistoryTab histories={histories} />}
                        {tab === 'trace' && <TraceTab traces={traces} />}
                    </div>
                </div>
            )}
        </div>
    )
}
