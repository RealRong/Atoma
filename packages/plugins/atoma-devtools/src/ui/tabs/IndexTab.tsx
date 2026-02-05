import type { DevtoolsIndexManagerSnapshot } from '../../runtime'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function IndexTab(props: { indexes: DevtoolsIndexManagerSnapshot[] }) {
    const entries = props.indexes.slice().sort((a, b) => a.name.localeCompare(b.name))
    if (!entries.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无索引数据</div>

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            {entries.map((idx) => (
                <Card key={idx.name} title={idx.name} right={<Pill>indexes: {idx.indexes.length}</Pill>}>
                    <JsonPre value={idx} />
                </Card>
            ))}
        </div>
    )
}
