import { useMemo, useState } from 'react'
import type { DebugEvent } from 'atoma'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'
import { formatIsoTime } from '../format'

type TraceState = Record<string, { traceId: string; events: DebugEvent[]; lastUpdatedAt: number }>

export function TraceTab(props: { traces: TraceState }) {
    const { traces } = props
    const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>(undefined)

    const list = useMemo(
        () => Object.values(traces).slice().sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt),
        [traces]
    )

    if (!list.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无 trace 事件（需要在 store 配置 debug.enabled + sampleRate）</div>

    const selected = selectedTraceId ? traces[selectedTraceId] : undefined

    return (
        <div className="flex h-full min-h-0 gap-3">
            <div className="w-[320px] shrink-0 overflow-auto rounded-xl border border-slate-200 bg-white">
                {list.map(t => {
                    const last = t.events[t.events.length - 1]
                    const active = selectedTraceId === t.traceId
                    return (
                        <button
                            key={t.traceId}
                            className={
                                active
                                    ? 'w-full border-b border-slate-200 bg-slate-50 px-3 py-2 text-left'
                                    : 'w-full border-b border-slate-200 px-3 py-2 text-left hover:bg-slate-50'
                            }
                            onClick={() => setSelectedTraceId(t.traceId)}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-slate-900">
                                    {t.traceId}
                                </strong>
                                <Pill>{t.events.length}</Pill>
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-600">
                                {String(last?.type || '-')} · {formatIsoTime(last?.timestamp)}
                            </div>
                        </button>
                    )
                })}
            </div>

            <div className="min-w-0 flex-1 overflow-auto pr-1">
                {selected
                    ? (
                        <Card title={selected.traceId} right={<Pill>{selected.events.length} events</Pill>}>
                            <JsonPre value={selected.events} maxHeight={520} />
                        </Card>
                    )
                    : <div className="text-xs text-slate-500">选择一个 trace 查看详情</div>}
            </div>
        </div>
    )
}
