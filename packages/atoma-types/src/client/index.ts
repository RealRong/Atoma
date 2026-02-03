export type { CreateClientOptions, BackendInput } from './options'

export type { CoreRuntime as ClientRuntime } from '../runtime'

export type {
    IoHandler,
    PersistHandler,
    ReadHandler,
    ObserveHandler,
    ObserveNext,
    HandlerMap,
    HandlerName,
    HandlerEntry,
    Register,
    PluginContext,
    ClientPluginContext,
    IoContext,
    PersistContext,
    ReadContext,
    ObserveContext,
    ReadRequest,
    QueryResult,
    ObserveRequest,
    ClientPlugin,
    PluginInitResult
} from './plugins'

export type { CapabilitiesRegistry, EndpointRegistry } from './registry'

export type {
    OperationEnvelope,
    ResultEnvelope,
    Driver,
    Endpoint
} from './drivers/types'

export type {
    ExecuteOpsInput,
    ExecuteOpsOutput,
    OpsClientLike
} from './backend'

export type {
    BelongsToSchema,
    HasManySchema,
    HasOneSchema,
    InferRelationsFromSchema,
    RelationMapFromSchema,
    RelationSchemaItem,
    RelationsSchema,
} from './relations'

export type { AtomaSchema, AtomaStoreSchema } from './schema'

export type {
    AtomaClient,
    AtomaStore,
    AtomaHistory,
    PluginCapableClient
} from './client'
