export { createAtomaHandlers } from './createAtomaHandlers'
export type {
    AtomaServerConfig,
    AtomaServerRoute,
    AtomaServerHookArgs,
    AtomaServerPlugins,
    AtomaOpsPlugin,
    AtomaSubscribePlugin,
    AtomaOpPlugin,
    AtomaOpPluginContext,
    AtomaOpPluginResult,
    AtomaServerPluginRuntime,
} from './config'
export type { AtomaServerLogger } from './logger'

export { AtomaError, createError, throwError } from './error'
export type { AtomaErrorDetails } from './error'

export type {
    IOrmAdapter,
    QueryResult,
    QueryResultOne,
    QueryResultMany,
    OrmAdapterOptions
} from './adapters/ports'

export { AtomaPrismaAdapter } from './adapters/prisma'
export type { PrismaAdapterOptions } from './adapters/prisma'
export { AtomaTypeormAdapter } from './adapters/typeorm'
export type { TypeormAdapterOptions } from './adapters/typeorm'

export type { ISyncAdapter, AtomaChange, IdempotencyResult } from './adapters/ports'
