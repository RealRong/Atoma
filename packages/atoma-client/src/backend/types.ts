import type { ExecuteOpsInput, ExecuteOpsOutput } from 'atoma-types/client'

export abstract class OpsClient {
    abstract executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput>
}
