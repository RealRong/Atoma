# StoreHandle 私有化设计说明（runtime 内部 API）

## 背景
当前 client 内部仍有少量逻辑需要访问 StoreHandle（如同步回写、历史回放、ack/回滚）。这些能力直接依赖 Jotai atom 与索引更新，属于内部管线级能力。为了继续私有化 StoreHandle，需要明确“对外 API 与对内管线能力”的边界。

## 目标
- 对外不暴露 StoreHandle（保持私有化）
- 保持底层锚定 Jotai atom，不引入额外抽象
- 保留内部对 atom/索引/写入管线的高效访问

## 方案对比
### 方案 A：扩展公开 Store API
把内部能力上移到 store 上，例如：
- `store.snapshot()` / `store.subscribe()`
- `store.applyWriteback()` / `store.applyPatches()`

问题：
- 公开 API 会膨胀，且容易被业务侧误用
- 写入路径需要携带 trace/ack/回滚上下文，放在 store 上不够一致
- Store 从“业务视图”膨胀成“内部管线入口”，职责变重

### 方案 B：提供 runtime 级内部 API（推荐）
把内部能力下沉到 runtime（内部使用），例如：
- `runtime.applyWriteback(storeName, payload)`
- `runtime.applyPatches(storeName, payload)`
- `runtime.getSnapshot(storeName)` / `runtime.subscribe(storeName, listener)`

优势：
- 与 MutationPipeline/Observability/ACK/回滚上下文一致
- 业务侧 API 不膨胀，Store 保持轻量
- 更符合 StoreHandle 私有化目标

## 结论
选择 **方案 B（runtime 内部 API）**。  
StoreHandle 继续作为内部实现细节存在，但不对外导出；内部管线通过 runtime 级 API 访问底层 Jotai atom 能力。

## Runtime 设计方案（解耦版）
### 定位
runtime 是 core 的“最小管线契约”，负责承载：
- 写入/回放/观测等管线上下文
- 与 Jotai atom 的基础运行时（jotaiStore）
- Store 创建与解析（resolveStore）

client 只是 runtime 的一个实现/装配器，负责把 ops、sync、outbox、observability 等能力接入到这个契约中。

### 分层与能力模块
**必需层（Core Runtime Contract）**  
core 只依赖这层，接口应最小且稳定：
- `jotaiStore`：Jotai 原生 store
- `resolveStore(name)`：通过名称获取 CoreStore
- `mutation`：包含写入管线与回放入口（dispatch/acks/history 等）
- `createObservabilityContext(storeName, ctx?)`：生成观测上下文

**可选能力层（Runtime Capabilities）**  
按需挂载，不影响 core：
- `sync`：同步相关能力（拉取/回写策略）
- `outbox`：离线队列能力
- `devtools`：运行时调试能力

### 建议接口草案（示意）
```ts
export type CoreRuntime = {
    jotaiStore: JotaiStore
    resolveStore: (name: string) => CoreStore<any, any>
    mutation: {
        api: {
            dispatch: (args: any) => void
        }
        acks: { ack: (key: string) => void; reject: (key: string, err: any) => void }
        history: {
            canUndo: (scope: string) => boolean
            canRedo: (scope: string) => boolean
            undo: (args: any) => Promise<void>
            redo: (args: any) => Promise<void>
            clear: (scope: string) => void
            listScopes: () => string[]
        }
    }
    createObservabilityContext: (storeName: string, ctx?: { traceId?: string; explain?: boolean }) => ObservabilityContext
}

export type RuntimeCapabilities = {
    sync?: {
        applyWriteback: (storeName: string, payload: any) => Promise<void>
        applyPatches: (storeName: string, payload: any) => Promise<void>
    }
    outbox?: {
        queueMode: 'queue' | 'local-first'
        ensureEnqueuer: () => OutboxEnqueuer
    }
    devtools?: {
        onStoreCreated: (listener: (store: CoreStore<any, any>) => void, options?: { replay?: boolean }) => () => void
    }
}
```

### 构建方式
- core 侧只依赖 `CoreRuntime` 与必要的能力接口，不依赖 client 实现
- client 侧负责装配：`createClientRuntime` 返回 `CoreRuntime & RuntimeCapabilities`
- store 创建仍由 core 完成，runtime 作为必需依赖注入

### 约束与边界
- runtime 只承载“管线与上下文”，不承载业务逻辑
- 继续锚定 Jotai atom（`jotaiStore` 必需存在）
- Store API 保持业务级读写与查询能力，不暴露管线级回放能力

## 过渡策略
短期仍可使用 `storeAccess.requireStoreHandle` 作为内部桥接，但仅限 client 内部与 core 内部模块使用。  
中期逐步把需要 handle 的逻辑迁移到 runtime 内部 API，由 runtime 统一持有与调度。

## 边界与约束
- 继续锚定 Jotai atom（不抽象成其他响应式层）
- Store API 仅承担业务读写与关系查询，不承担“管线级写入/回放”
- runtime 内部 API 为非公开能力，仅供 client/core 内部使用

## 分阶段实施（一步到位，无中间层/兼容层）
本计划按阶段推进，但每个阶段都以“直接替换”为原则，不新增临时兼容层。

### 阶段 1：Runtime 契约落地（一次性确定）
- 在 core 内定义最小 `CoreRuntime` 契约与能力接口（类型与实现边界清晰）
- 移除 core 对 client runtime 类型的依赖，仅依赖契约
- 将 runtime 相关类型集中到 core（或 core/internal），避免 client 泄漏到 core

### 阶段 2：Client 实现直切换
- `createClientRuntime` 直接实现 `CoreRuntime & RuntimeCapabilities`
- client 内部模块全部改用 runtime 内部 API，不再直接访问 StoreHandle
- Store 构造统一注入 runtime（不保留旧路径）

### 阶段 3：清理与收口
- 移除对外 `StoreHandle` 导出与任何遗留引用
- 删除 handle 缓存与注册表的对外入口（保留内部必需实现）
- 文档与示例同步更新（仅保留新 runtime 模式）

### 验收标准
- core 不引用 client runtime 类型
- client 不直接访问 StoreHandle
- storeAccess 仅在 core/client 内部使用，不对外公开
