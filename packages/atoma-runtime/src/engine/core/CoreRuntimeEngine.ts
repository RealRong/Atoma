import type { RuntimeEngine } from 'atoma-types/runtime'
import { CoreIndexEngine } from './CoreIndexEngine'
import { CoreMutationEngine } from './CoreMutationEngine'
import { CoreOperationEngine } from './CoreOperationEngine'
import { CoreQueryEngine } from './CoreQueryEngine'
import { CoreRelationEngine } from './CoreRelationEngine'

export class CoreRuntimeEngine implements RuntimeEngine {
    readonly index = new CoreIndexEngine()
    readonly query = new CoreQueryEngine()
    readonly relation = new CoreRelationEngine()
    readonly mutation = new CoreMutationEngine()
    readonly operation = new CoreOperationEngine()
}
