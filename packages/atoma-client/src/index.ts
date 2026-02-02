export { createClient } from './internal/createClient'
export { presets } from './presets'
export type { CreateClientOptions } from './types'
export { EndpointRegistry } from './drivers/EndpointRegistry'
export { PluginRegistry, HandlerChain, ClientPlugin, ClientPlugin as PluginBase } from './plugins'
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
