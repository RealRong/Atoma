import type { ExecuteOpsInput, ExecuteOpsOutput } from 'atoma-types/client/ops'

export abstract class OpsClient {
    abstract executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput>
}
