import type { IndexSnapshot, IndexQueryPlan } from 'atoma'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function IndexTab(props: { indexes: Record<string, { indexes: IndexSnapshot[]; lastQuery?: IndexQueryPlan }> }) {
    const entries = Object.entries(props.indexes)
    if (!entries.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无索引数据</div>

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            {entries.map(([name, idx]) => (
                <Card key={name} title={name} right={<Pill>indexes: {idx.indexes.length}</Pill>}>
                    <JsonPre value={idx} />
                </Card>
            ))}
        </div>
    )
}
