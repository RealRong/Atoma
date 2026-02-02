export { createClient } from './internal/createClient'
export type { CreateClientOptions } from './types'
export { EndpointRegistry } from './drivers/EndpointRegistry'
export { PluginRegistry, HandlerChain } from './plugins'
export type { ClientPlugin } from './plugins'
export { registerClientRuntime, getClientRuntime, requireClientRuntime } from './internal/runtimeRegistry'

export type {
    PersistHandler,
    ReadHandler,
    ObserveHandler,
    HandlerMap,
    HandlerName,
    HandlerEntry,
    Register,
    PluginContext,
    ClientPluginContext,
    PluginInitResult,
    PluginCapableClient,
    ClientRuntime,
    AtomaClient,
    AtomaHistory
} from './types'

export type {
    OperationEnvelope,
    ResultEnvelope,
    Driver,
    Endpoint
} from './drivers/types'

export type {
    ExecuteOpsInput,
    ExecuteOpsOutput,
    OpsClientLike,
} from './backend/types'

export type { HttpOpsClientConfig } from './backend/http/HttpOpsClient'
