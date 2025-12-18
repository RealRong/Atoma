import type { HistoryEntrySummary } from 'atoma'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function HistoryTab(props: { histories: Record<string, { pointer: number; length: number; entries: HistoryEntrySummary[] }> }) {
    const entries = Object.entries(props.histories)
    if (!entries.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无历史数据</div>

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            {entries.map(([name, h]) => (
                <Card key={name} title={name} right={<Pill>pointer: {h.pointer}/{h.length}</Pill>}>
                    <JsonPre value={h.entries.slice(-10)} />
                </Card>
            ))}
        </div>
    )
}
