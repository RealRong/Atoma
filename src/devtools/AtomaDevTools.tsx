import { useEffect, useMemo, useState } from 'react'
import type { DevtoolsEvent, StoreSnapshot, IndexSnapshot, QueueItem, IndexQueryPlan } from './types'
import { enableGlobalDevtools, getGlobalDevtools } from './global'

type StoreState = Record<string, StoreSnapshot>
type IndexState = Record<string, { indexes: IndexSnapshot[]; lastQuery?: IndexQueryPlan }>
type QueueState = Record<string, { pending: QueueItem[]; failed: QueueItem[] }>
type HistoryState = Record<string, { pointer: number; length: number; entries: any[] }>

export function AtomaDevTools() {
    const [resolvedBridge] = useState(() => getGlobalDevtools() ?? enableGlobalDevtools())
    const [open, setOpen] = useState(false)
    const [stores, setStores] = useState<StoreState>({})
    const [indexes, setIndexes] = useState<IndexState>({})
    const [queues, setQueues] = useState<QueueState>({})
    const [histories, setHistories] = useState<HistoryState>({})
    const [tab, setTab] = useState<'store' | 'index' | 'queue' | 'history'>('store')

    useEffect(() => {
        if (!resolvedBridge) return
        const unsub = resolvedBridge.subscribe((e: DevtoolsEvent) => {
            if (e.type === 'store-snapshot') {
                setStores(prev => ({ ...prev, [e.payload.name]: e.payload }))
            } else if (e.type === 'index-snapshot') {
                setIndexes(prev => ({ ...prev, [e.payload.name]: { indexes: e.payload.indexes, lastQuery: e.payload.lastQuery } }))
            } else if (e.type === 'queue-snapshot') {
                setQueues(prev => ({ ...prev, [e.payload.name]: { pending: e.payload.pending, failed: e.payload.failed } }))
            } else if (e.type === 'history-snapshot') {
                setHistories(prev => ({ ...prev, [e.payload.name]: { pointer: e.payload.pointer, length: e.payload.length, entries: e.payload.entries } }))
            }
        })
        return () => unsub && unsub()
    }, [resolvedBridge])

    const totalCount = useMemo(
        () => Object.values(stores).reduce((sum, s) => sum + s.count, 0),
        [stores]
    )

    return (
        <div style={floatingStyle}>
            <div style={headerStyle}>
                <span>Atoma DevTools</span>
                <div>
                    <span style={{ marginRight: 8, opacity: 0.8 }}>缓存：{totalCount}</span>
                    <button style={btnStyle} onClick={() => setOpen(o => !o)}>
                        {open ? '收起' : '展开'}
                    </button>
                </div>
            </div>
            {open && (
                <div style={panelStyle}>
                    <div style={tabRowStyle}>
                        {['store', 'index', 'queue', 'history'].map(key => (
                            <button
                                key={key}
                                style={tab === key ? tabBtnActive : tabBtn}
                                onClick={() => setTab(key as any)}
                            >
                                {key}
                            </button>
                        ))}
                    </div>

                    {tab === 'store' && (
                        <>
                            {Object.values(stores).length === 0 && <div style={mutedStyle}>暂无数据，确认 devtools bridge 已注册。</div>}
                            {Object.values(stores).map(store => (
                                <div key={store.name} style={cardStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <strong>{store.name}</strong>
                                        <span style={pillStyle}>{store.count} items</span>
                                    </div>
                                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                                        大小估算：{store.approxSize} bytes · 更新时间：{new Date(store.timestamp).toLocaleTimeString()}
                                    </div>
                                    {store.sample.length > 0 && (
                                        <pre style={preStyle}>{JSON.stringify(store.sample, null, 2)}</pre>
                                    )}
                                </div>
                            ))}
                        </>
                    )}

                    {tab === 'index' && (
                        <>
                            {Object.keys(indexes).length === 0 && <div style={mutedStyle}>暂无索引快照</div>}
                            {Object.entries(indexes).map(([name, payload]) => (
                                <div key={name} style={cardStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <strong>{name}</strong>
                                        <span style={pillStyle}>{payload.indexes.length} indexes</span>
                                    </div>
                                    {payload.lastQuery && (
                                        <pre style={preStyle}>{JSON.stringify(payload.lastQuery, null, 2)}</pre>
                                    )}
                                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                                        {payload.indexes.map(idx => (
                                            <div key={idx.field} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                <span>
                                                    {idx.field} ({idx.type}){idx.dirty ? ' *dirty*' : ''}
                                                </span>
                                                <span style={mutedStyle}>docs: {idx.size ?? '-'} · distinct: {idx.distinctValues ?? '-'}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    {tab === 'queue' && (
                        <>
                            {Object.keys(queues).length === 0 && <div style={mutedStyle}>暂无队列数据</div>}
                            {Object.entries(queues).map(([name, q]) => (
                                <div key={name} style={cardStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <strong>{name}</strong>
                                        <span style={pillStyle}>pending: {q.pending.length}</span>
                                    </div>
                                    <pre style={preStyle}>{JSON.stringify(q.pending, null, 2)}</pre>
                                </div>
                            ))}
                        </>
                    )}

                    {tab === 'history' && (
                        <>
                            {Object.keys(histories).length === 0 && <div style={mutedStyle}>暂无历史数据</div>}
                            {Object.entries(histories).map(([name, h]) => (
                                <div key={name} style={cardStyle}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <strong>{name}</strong>
                                        <span style={pillStyle}>pointer: {h.pointer}/{h.length}</span>
                                    </div>
                                    <pre style={preStyle}>{JSON.stringify(h.entries.slice(-10), null, 2)}</pre>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

const floatingStyle: React.CSSProperties = {
    position: 'fixed',
    right: 18,
    bottom: 18,
    width: 360,
    maxHeight: '70vh',
    background: '#0f172a',
    color: '#f8fafc',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 12,
    boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
    fontSize: 14,
    zIndex: 9999,
    overflow: 'hidden'
}

const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.04)'
}

const panelStyle: React.CSSProperties = {
    padding: '10px',
    overflowY: 'auto',
    maxHeight: '60vh'
}

const cardStyle: React.CSSProperties = {
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '10px',
    marginBottom: 10,
    background: 'rgba(255,255,255,0.03)'
}

const mutedStyle: React.CSSProperties = { opacity: 0.7, fontSize: 13 }

const pillStyle: React.CSSProperties = {
    padding: '2px 8px',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.12)',
    fontSize: 12
}

const tabRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    marginBottom: 8
}

const tabBtn: React.CSSProperties = {
    background: '#1f2937',
    color: '#f8fafc',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer'
}

const tabBtnActive: React.CSSProperties = {
    ...tabBtn,
    background: '#3b82f6',
    borderColor: '#3b82f6',
    color: '#0b1220'
}

const preStyle: React.CSSProperties = {
    marginTop: 8,
    borderRadius: 8,
    background: '#0b1220',
    border: '1px solid rgba(255,255,255,0.08)',
    padding: 8,
    maxHeight: 200,
    overflow: 'auto',
    fontSize: 12
}

const btnStyle: React.CSSProperties = {
    background: '#1f2937',
    color: '#f8fafc',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer'
}

export default AtomaDevTools
