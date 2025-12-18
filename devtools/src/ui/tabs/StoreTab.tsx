import { useEffect, useMemo, useState } from 'react'
import type { StoreSnapshot } from 'atoma'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function StoreTab(props: { stores: Record<string, StoreSnapshot> }) {
    const { stores } = props
    const entries = useMemo(
        () => Object.entries(stores).sort(([a], [b]) => a.localeCompare(b)),
        [stores]
    )
    const [selectedName, setSelectedName] = useState<string | undefined>(undefined)

    useEffect(() => {
        if (!entries.length) {
            setSelectedName(undefined)
            return
        }
        if (!selectedName || !stores[selectedName]) {
            setSelectedName(entries[0][0])
        }
    }, [entries, selectedName, stores])

    if (!entries.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无 store 数据</div>

    const selected = selectedName ? stores[selectedName] : undefined

    return (
        <div className="flex h-full min-h-0 gap-3">
            <div className="w-[260px] shrink-0 overflow-auto rounded-xl border border-slate-200 bg-white">
                {entries.map(([name, s]) => {
                    const active = name === selectedName
                    return (
                        <button
                            key={name}
                            className={
                                active
                                    ? 'flex w-full items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-left'
                                    : 'flex w-full items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 text-left hover:bg-slate-50'
                            }
                            onClick={() => setSelectedName(name)}
                        >
                            <span className="min-w-0">
                                <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold text-slate-900">
                                    {name}
                                </span>
                                <span className="mt-0.5 block text-[11px] text-slate-500">store</span>
                            </span>
                            <Pill>{s.count}</Pill>
                        </button>
                    )
                })}
            </div>

            <div className="min-w-0 flex-1 overflow-auto pr-1">
                {selected
                    ? (
                        <Card title={selectedName ?? '-'} right={<Pill>count: {selected.count}</Pill>}>
                            <JsonPre value={selected} maxHeight={520} />
                        </Card>
                    )
                    : <div className="text-xs text-slate-500">选择一个 store 查看详情</div>}
            </div>
        </div>
    )
}
