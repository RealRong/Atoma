/**
 * Atoma（React-first public API）
 *
 * 约定：用户不直接接触 core 的 createCoreStore/createStore/Core 等低层入口；
 * 对外统一从顶层 client + react hooks 入口进入（defineEntities/createOpContext/useFindMany 等）。
 */

export { defineEntities, createOpContext } from './client/createAtomaClient'
export type { CreateOpContextArgs, DefineClientConfig, AtomaStoresConfig, AtomaClient, AtomaHistory, AtomaSync, AtomaSyncStatus } from './client/types'
export type { AtomaClientSyncConfig } from './client/sync'
export type { OperationContext, OperationOrigin } from './core'

export { enableGlobalDevtools, getGlobalDevtools } from './devtools/global'
export { createDevtoolsBridge } from './devtools/bridge'
export type { DevtoolsBridge, DevtoolsEvent, StoreSnapshot, IndexSnapshot, QueueItem, IndexQueryPlan, HistoryEntrySummary } from './devtools/types'
export type { DebugEvent } from './observability'

export * from './react'
