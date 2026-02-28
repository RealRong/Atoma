export { createAtomaHandlers } from './createAtomaHandlers'
export type {
    AtomaServerConfig,
    AtomaServerRoute,
    AtomaServerHookArgs,
    AtomaServerPlugins,
    AtomaOpsPlugin,
    AtomaRoutePlugin,
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
    OrmAdapterOptions
} from './adapters/ports'

export { AtomaPrismaAdapter } from './adapters/prisma'
export type { PrismaAdapterOptions } from './adapters/prisma'

export type { ISyncAdapter, AtomaChange, IdempotencyResult } from './adapters/ports'
