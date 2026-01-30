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
} from '../plugins/types'

export { ClientPlugin } from '../plugins/ClientPlugin'

export interface PluginCapableClient {
    dispose: () => void
}
