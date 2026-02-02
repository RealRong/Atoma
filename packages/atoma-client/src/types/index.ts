export type { CreateClientOptions } from './options'

export type { CoreRuntime as ClientRuntime } from 'atoma-runtime'

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
} from '../plugins'

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
