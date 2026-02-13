import type { ExecuteOperationsInput, ExecuteOperationsOutput } from 'atoma-types/client/ops'

export abstract class OperationClientBase {
    abstract executeOperations(input: ExecuteOperationsInput): Promise<ExecuteOperationsOutput>
}
