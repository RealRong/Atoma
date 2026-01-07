import type { DevtoolsHistorySnapshot } from 'atoma/devtools'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function HistoryTab(props: { history: DevtoolsHistorySnapshot }) {
    const scopes = props.history.scopes.slice().sort((a, b) => a.scope.localeCompare(b.scope))
    if (!scopes.length) return <div className="h-full min-h-0 overflow-auto text-xs text-slate-500">暂无历史数据</div>

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            <Card
                title="scopes"
                right={<Pill>scopes: {scopes.length}</Pill>}
            >
                <JsonPre value={scopes} />
            </Card>
        </div>
    )
}
