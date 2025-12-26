export { createAtomaServer, authzHelpers } from './createAtomaServer'
export type {
    AtomaServerConfig,
    AtomaServerRoute,
    AtomaServerHookArgs,
    AtomaAuthorizeHookArgs,
    AtomaValidateWriteHookArgs,
    AtomaAuthzHooks
} from './config'
export type { AtomaServerLogger } from './logger'

export { AtomaError, createError, throwError } from './error'
export type { ErrorKind, AtomaErrorDetails } from './error'

export type {
    IOrmAdapter,
    OrderByRule,
    CursorToken,
    Page,
    QueryParams,
    QueryResult,
    QueryResultOne,
    QueryResultMany,
    WriteOptions,
    OrmAdapterOptions,
    StandardError
} from './types'

export { AtomaPrismaAdapter } from './adapters/prisma'
export type { PrismaAdapterOptions } from './adapters/prisma'
export { AtomaTypeormAdapter } from './adapters/typeorm'
export type { TypeormAdapterOptions } from './adapters/typeorm'

export type { ISyncAdapter, AtomaChange, ChangeKind, IdempotencyResult } from './sync/types'
