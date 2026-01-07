import type { DevtoolsSyncSnapshot } from 'atoma/devtools'
import { Card } from '../components/Card'
import { Pill } from '../components/Pill'
import { JsonPre } from '../components/JsonPre'

export function SyncTab(props: { sync: DevtoolsSyncSnapshot }) {
    const { sync } = props
    const status = sync.status
    const queue = sync.queue

    return (
        <div className="h-full min-h-0 overflow-auto pr-1">
            <Card
                title="sync"
                right={
                    <div className="flex items-center gap-2">
                        <Pill>configured: {String(status.configured)}</Pill>
                        <Pill>started: {String(status.started)}</Pill>
                        {queue && <Pill>pending: {queue.pending}</Pill>}
                        {queue && <Pill>failed: {queue.failed}</Pill>}
                    </div>
                }
            >
                <JsonPre value={sync} />
            </Card>
        </div>
    )
}

