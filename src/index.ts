/**
 * Atoma（React-first public API）
 *
 * 约定：用户不直接接触 core 的 createStore/Core 等低层入口；
 * 对外统一从顶层 client + react hooks 入口进入（defineEntities/createOpContext/useFindMany 等）。
 */

export { defineEntities } from './client'
export { createOpContext } from './core/operationContext'
export type { CreateOpContextArgs } from './core/operationContext'
export type {
    AtomaClientBuilder,
    AtomaClientSyncConfig,
    AtomaStoresConfig,
    AtomaClient,
    AtomaHistory,
    AtomaSync,
    AtomaSyncStartMode,
    AtomaSyncStatus,
    BackendConfig,
    BackendEndpointConfig,
    CustomOpsBackendConfig,
    HttpBackendConfig,
    HttpSubscribeConfig,
    HttpSyncBackendConfig,
    IndexedDBBackendConfig,
    MemoryBackendConfig,
    ResolvedBackends,
    StoreBackendEndpointConfig,
    StoreBatchArgs,
    StoreCustomOpsBackendConfig,
    StoreDefaultsArgs
} from './client/types'
export { Backend } from '#backend'
export type { OpsClient, ExecuteOpsInput, ExecuteOpsOutput } from '#backend'
export type { OperationContext, OperationOrigin } from './core'

export { enableGlobalDevtools, getGlobalDevtools } from './devtools/global'
export { createDevtoolsBridge } from './devtools/bridge'
export type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot, IndexSnapshot, QueueItem, IndexQueryPlan, HistoryEntrySummary } from './devtools/types'
export type { DebugEvent } from './observability'

export * from './react'
