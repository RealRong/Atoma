import type { RuntimeEngine } from 'atoma-types/runtime'
import { CoreIndexEngine } from './core/CoreIndexEngine'
import { CoreMutationEngine } from './core/CoreMutationEngine'
import { CoreOperationEngine } from './core/CoreOperationEngine'
import { CoreQueryEngine } from './core/CoreQueryEngine'
import { CoreRelationEngine } from './core/CoreRelationEngine'

export class CoreRuntimeEngine implements RuntimeEngine {
    readonly index = new CoreIndexEngine()
    readonly query = new CoreQueryEngine()
    readonly relation = new CoreRelationEngine()
    readonly mutation = new CoreMutationEngine()
    readonly operation = new CoreOperationEngine()
}
