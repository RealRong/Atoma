import { useEffect, useMemo, useRef, useState } from 'react'
import { Devtools } from 'atoma/devtools'
import type { DevtoolsClientSnapshot, DevtoolsEvent } from 'atoma/devtools'
import { TabButtonRow } from './components/TabButtonRow'
import { StoreTab } from './tabs/StoreTab'
import { IndexTab } from './tabs/IndexTab'
import { SyncTab } from './tabs/SyncTab'
import { HistoryTab } from './tabs/HistoryTab'
import { TraceTab } from './tabs/TraceTab'

export default function DevtoolsApp(props: { defaultOpen?: boolean }) {
    const { defaultOpen } = props
    const [open, setOpen] = useState(Boolean(defaultOpen))
    const [tab, setTab] = useState<'store' | 'index' | 'sync' | 'history' | 'trace'>('store')

    const [clients, setClients] = useState<Array<{ id: string; label?: string; createdAt: number; lastSeenAt: number }>>([])
    const [selectedClientId, setSelectedClientId] = useState<string | undefined>(undefined)
    const [snapshot, setSnapshot] = useState<DevtoolsClientSnapshot | null>(null)

    const unsubRef = useRef<null | (() => void)>(null)

    useEffect(() => {
        if (!open) return

        const global = Devtools.global()
        const refresh = () => {
            const list = global.clients.list()
            setClients(list)

            const nextSelected = selectedClientId ?? list[0]?.id
            if (nextSelected && nextSelected !== selectedClientId) {
                setSelectedClientId(nextSelected)
            }

            if (!nextSelected) {
                setSnapshot(null)
                return
            }

            try {
                const ins = global.clients.get(nextSelected)
                setSnapshot(ins.snapshot())
            } catch {
                setSnapshot(null)
            }
        }

        refresh()
        const t = setInterval(refresh, 500)
        return () => clearInterval(t)
    }, [open, selectedClientId])

    useEffect(() => {
        unsubRef.current?.()
        unsubRef.current = null

        if (!open) return
        if (!selectedClientId) return

        const global = Devtools.global()
        try {
            const ins = global.clients.get(selectedClientId)
            unsubRef.current = ins.subscribe((_e: DevtoolsEvent) => {
                // snapshot-first：事件仅触发刷新（实际数据以 snapshot 为准）
                try {
                    setSnapshot(ins.snapshot())
                } catch {
                    // ignore
                }
            })
        } catch {
            // ignore
        }

        return () => {
            unsubRef.current?.()
            unsubRef.current = null
        }
    }, [open, selectedClientId])

    const totalCount = useMemo(() => {
        return snapshot?.stores.reduce((sum, s) => sum + s.count, 0) ?? 0
    }, [snapshot])

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
                <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-semibold">Atoma DevTools</span>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-600">
                        {selectedClientId
                            ? `client: ${selectedClientId}${snapshot?.label ? ` (${snapshot.label})` : ''}`
                            : 'client: -'}
                    </span>
                </div>
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
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-700">Clients</span>
                        <select
                            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-900"
                            value={selectedClientId ?? ''}
                            onChange={(e) => setSelectedClientId(e.target.value)}
                        >
                            {clients.length === 0 && (
                                <option value="" disabled>暂无 client（先 createClient）</option>
                            )}
                            {clients.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.label ? `${c.label} (${c.id})` : c.id}
                                </option>
                            ))}
                        </select>
                    </div>

                    <TabButtonRow tab={tab} setTab={setTab} />

                    <div className="min-h-0 flex-1 overflow-hidden">
                        {tab === 'store' && <StoreTab stores={snapshot?.stores ?? []} />}
                        {tab === 'index' && <IndexTab indexes={snapshot?.indexes ?? []} />}
                        {tab === 'sync' && <SyncTab sync={snapshot?.sync ?? { status: { configured: false, started: false } }} />}
                        {tab === 'history' && <HistoryTab history={snapshot?.history ?? { scopes: [] }} />}
                        {tab === 'trace' && <TraceTab />}
                    </div>
                </div>
            )}
        </div>
    )
}
