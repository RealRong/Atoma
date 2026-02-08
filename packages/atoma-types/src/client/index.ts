export type { CreateClientOptions } from './options'

export type { CoreRuntime as ClientRuntime } from '../runtime'

export type {
    IoHandler,
    PersistHandler,
    ReadHandler,
    HandlerMap,
    HandlerName,
    HandlerEntry,
    Register,
    PluginContext,
    ClientPluginContext,
    IoContext,
    PersistContext,
    ReadContext,
    ReadRequest,
    PluginReadResult,
    ClientPlugin,
    PluginInitResult
} from './plugins'

export type { CapabilitiesRegistry } from './registry'

export type {
    ExecuteOpsInput,
    ExecuteOpsOutput,
    OperationEnvelope,
    ResultEnvelope,
    OpsClientLike
} from './ops'

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
