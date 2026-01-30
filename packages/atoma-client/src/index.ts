export { createClient } from './internal/createClient'
export { presets } from './presets'
export type { CreateClientOptions } from './types'
export { EndpointRegistry } from './drivers/EndpointRegistry'
export { PluginRegistry } from './plugins/PluginRegistry'
export { HandlerChain } from './plugins/HandlerChain'
export { RuntimeCore } from './runtime/RuntimeCore'
export { ClientPlugin as PluginBase } from './plugins/ClientPlugin'
export { registerClientRuntime, getClientRuntime, requireClientRuntime } from './internal/runtimeRegistry'

export type {
    ClientPlugin,
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
    HttpOpsClientConfig
} from './backend/types'
