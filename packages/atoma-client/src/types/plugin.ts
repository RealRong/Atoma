export type {
    Next,
    ObserveNext,
    IoHandler,
    PersistHandler,
    ReadHandler,
    ObserveHandler,
    HandlerMap,
    HandlerName,
    HandlerEntry,
    Register,
    PluginContext,
    IoContext,
    PersistContext,
    ReadContext,
    ObserveContext,
    ReadRequest,
    QueryResult,
    ObserveRequest
} from '../plugins'

export { ClientPlugin } from '../plugins'

export interface PluginCapableClient {
    dispose: () => void
}
