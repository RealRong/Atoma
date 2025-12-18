import type { QueueItem } from 'atoma'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function QueueTab(props: { queues: Record<string, { pending: QueueItem[]; failed: QueueItem[] }> }) {
    const entries = Object.entries(props.queues)
    if (!entries.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无队列数据</div>

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            {entries.map(([name, q]) => (
                <Card key={name} title={name} right={<Pill>pending: {q.pending.length}</Pill>}>
                    <JsonPre value={q.pending} />
                </Card>
            ))}
        </div>
    )
}
