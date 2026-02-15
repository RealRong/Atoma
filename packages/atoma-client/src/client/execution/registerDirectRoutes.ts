import type { Runtime } from 'atoma-runtime'
import { buildLocalExecutor } from './localExecution'

const LOCAL_EXECUTOR_ID = 'local'
const DIRECT_LOCAL_ROUTE_ID = 'direct-local'

export function registerDirectRoutes({
    runtime
}: {
    runtime: Runtime
}): () => void {
    return runtime.execution.apply({
        id: 'builtin.direct',
        executors: {
            [LOCAL_EXECUTOR_ID]: buildLocalExecutor({ runtime })
        },
        routes: {
            [DIRECT_LOCAL_ROUTE_ID]: {
                query: LOCAL_EXECUTOR_ID,
                write: LOCAL_EXECUTOR_ID
            }
        },
        defaultRoute: DIRECT_LOCAL_ROUTE_ID
    })
}
