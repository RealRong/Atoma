import type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike } from 'atoma-types/client'

export type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike } from 'atoma-types/client'

export abstract class OpsClient {
    abstract executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput>
}
