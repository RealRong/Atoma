# 查询系统最终设计（破坏式重构，直接替换现有 v1）

> 本文是最终定型版本：无需兼容旧实现，直接替换现有查询协议与代码。

## 设计原则
- **单一语义**：本地/服务端/各种后端执行结果一致。
- **可编译**：查询必须能编译为计划（本地解释器 + 服务端 SQL/ORM）。
- **稳定分页**：统一 keyset cursor 语义与稳定排序。
- **统一 API**：只保留一种 Query 结构，不接受函数过滤。
- **简洁命名**：使用行业通用术语：`filter/sort/page/select`。

## 核心 API（客户端）
### 最终 Query 结构
```ts
type Query<T> = {
    filter?: FilterExpr<T>
    sort?: SortRule<T>[]
    page?: PageSpec
    select?: Array<keyof T & string>
    include?: Record<string, Query<any>>
    explain?: boolean
}

type SortRule<T> = { field: keyof T & string; dir: 'asc' | 'desc' }

type PageSpec =
    | { mode: 'offset'; limit?: number; offset?: number; includeTotal?: boolean }
    | { mode: 'cursor'; limit?: number; after?: CursorToken; before?: CursorToken }

type CursorToken = string
```

### 客户端方法命名（最终）
- `store.query(query: Query<T>): Promise<QueryResult<T>>`  
  返回列表结果与分页信息，唯一主入口。  
- `store.queryOne(query: Query<T>): Promise<QueryOneResult<T>>`  
  语义上只取单条（内部强制 limit=1），便于读单条。  

对应结果类型：
```ts
type QueryResult<T> = {
    data: T[]
    pageInfo?: PageInfo
    explain?: any
}

type QueryOneResult<T> = {
    data?: T
    explain?: any
}
```

### 过滤表达式（可编译 DSL）
```ts
type FilterExpr<T> =
    | { op: 'and'; args: FilterExpr<T>[] }
    | { op: 'or'; args: FilterExpr<T>[] }
    | { op: 'not'; arg: FilterExpr<T> }
    | { op: 'eq'; field: keyof T & string; value: any }
    | { op: 'in'; field: keyof T & string; values: any[] }
    | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: keyof T & string; value: number }
    | { op: 'startsWith' | 'endsWith' | 'contains'; field: keyof T & string; value: string }
    | { op: 'isNull'; field: keyof T & string }
    | { op: 'exists'; field: keyof T & string }
    | { op: 'text'; field: keyof T & string; query: string; mode?: 'match' | 'fuzzy'; distance?: 0 | 1 | 2 }
```

### 使用示例
```ts
const res = await store.query({
    filter: {
        op: 'and',
        args: [
            { op: 'eq', field: 'status', value: 'active' },
            { op: 'gte', field: 'age', value: 18 }
        ]
    },
    sort: [{ field: 'createdAt', dir: 'desc' }],
    page: { mode: 'cursor', limit: 20, after: cursor },
    select: ['id', 'name', 'createdAt'],
    explain: true
})
```

## 查询协议（Ops 里的 query）
### QueryOp（最终形态）
```ts
type QueryOp = {
    opId: string
    kind: 'query'
    query: {
        resource: string
        query: Query<any>
    }
    meta?: Meta // v=1
}
```

### QueryResultData（最终形态）
```ts
type QueryResultData = {
    data: unknown[]
    pageInfo?: PageInfo
    explain?: any
}
```

### OpsRequest / OpsResponseData（v=1 直接替换）
```ts
type OpsRequest = {
    meta: { v: 1; traceId?: string; requestId?: string; clientTimeMs?: number }
    ops: Operation[]
}

type OpsResponseData = {
    results: OperationResult[]
}
```

## 语义规范（强一致）
### 1) 稳定排序
- 若 `query.sort` 为空，默认 `[{ field: 'id', dir: 'asc' }]`。
- 若 `query.sort` 不包含 `id`，自动追加 `id asc`（稳定 tie-breaker）。

### 2) Cursor token 规范
- token 结构：`base64url(JSON.stringify({ v: 1, sort: [{field,dir}...], values: [...] }))`。
- `values` 顺序与 `sort` 一致。

### 3) 分页规则
- **offset 模式**：
  - 使用 `limit/offset`；`includeTotal=true` 才返回 `total`。
- **cursor 模式**：
  - 使用 keyset；默认不返回 `total`。
  - `after` 向后翻页，`before` 向前翻页。

### 4) select 投影
- `select` 只影响最终输出字段。
- 内部执行自动补齐 sort 所需字段，以保证 cursor 与排序正确。

### 5) filter 约束
- 仅接受 `FilterExpr` AST，不接受函数过滤。
- `text` 是否可用由后端能力决定（见能力协商）。

## 执行架构（最终）
```
Query -> Normalize -> QueryPlan -> Execute
```

### Normalize
- 归一化 sort（追加 id）。
- 校验 FilterExpr（递归结构）。
- 校验 page（cursor/offset 互斥）。
- 记录 select 与 sort 依赖。

### Plan
- 选择索引候选集合。
- 选择分页策略（offset/keyset）。
- 生成投影计划。

### Execute
- 本地执行：索引筛选 → Expr 解释 → 排序 → 分页 → 投影。
- 服务端执行：Expr 编译到 ORM/SQL → keyset/offset → 投影。

## 能力协商（可选）
```ts
type QueryCapabilities = {
    operators: Array<FilterExpr<any>['op']>
    textSearch: boolean
    keysetCursor: true
}
```

## 协议在 atoma/protocol 中的落位（直接替换 v1）
**核心文件（新增/修改）**：
- `packages/atoma/src/protocol/ops/query.ts`
  - 新增：`Query`、`FilterExpr`、`SortRule`、`PageSpec`、`CursorToken`、`PageInfo`
  - 删除旧 `QueryParams` / `OrderByRule`
- `packages/atoma/src/protocol/ops/types.ts`
  - `QueryOp` 改为 `query.query: Query`
  - `QueryResultData` 改为 `{ data, pageInfo?, explain? }`
- `packages/atoma/src/protocol/ops/build.ts`
  - `buildQueryOp` 参数改为 `query: Query`
- `packages/atoma/src/protocol/ops/validate/query.ts`
  - 校验 `Query`/`FilterExpr`/`PageSpec`/`SortRule`
  - 校验 cursor token 结构
- `packages/atoma/src/protocol/ops/validate/operation.ts`
  - QueryOp 结构改为 `query.query`
- `packages/atoma/src/protocol/ops/validate/result.ts`
  - QueryResultData 改为 `data` 字段
- `packages/atoma/src/protocol/index.ts`
  - 导出 `Query`、`FilterExpr`、`SortRule`、`PageSpec`、`CursorToken`、`PageInfo`
- `packages/atoma/src/protocol/Protocol.ts`
  - 透出新 build/validate

## 分阶段实施方案（文件级变更清单）
### Phase 0：协议替换（v1）
- 重写 `packages/atoma/src/protocol/ops/query.ts`
- 修改 `packages/atoma/src/protocol/ops/types.ts`
- 修改 `packages/atoma/src/protocol/ops/build.ts`
- 修改 `packages/atoma/src/protocol/ops/validate/query.ts`
- 修改 `packages/atoma/src/protocol/ops/validate/operation.ts`
- 修改 `packages/atoma/src/protocol/ops/validate/result.ts`
- 修改 `packages/atoma/src/protocol/index.ts`
- 修改 `packages/atoma/src/protocol/Protocol.ts`

### Phase 1：核心编译器与执行引擎
- 新增 `packages/atoma/src/core/query/normalize.ts`
- 新增 `packages/atoma/src/core/query/plan.ts`
- 新增 `packages/atoma/src/core/query/engine/local.ts`
- 新增 `packages/atoma/src/core/query/cursor.ts`
- 修改 `packages/atoma/src/core/query/index.ts`（导出新 API）
- 替换 `packages/atoma/src/core/query/QueryMatcher.ts`（改为 FilterExpr 解释器）

### Phase 2：客户端 API 与运行时
- 修改 `packages/atoma/src/core/types.ts`（替换 FindManyOptions 为 Query）
- 修改 `packages/atoma/src/core/store/ops/findMany/index.ts`（改为 find/query 新 API）
- 删除 `packages/atoma/src/core/store/internals/queryParams.ts`
- 修改 `packages/atoma/src/client/internal/factory/runtime/createClientRuntime.ts`（QueryOp 新结构）
- 修改 `packages/atoma/src/core/runtime/createRuntimeIo.ts`

### Phase 3：本地后端统一执行
- 修改 `packages/atoma-backend-memory/src/MemoryOpsClient.ts`
- 修改 `packages/atoma-backend-indexeddb/src/IndexedDBOpsClient.ts`

### Phase 4：atoma-server 适配
- 新增 `packages/atoma-server/src/query/compile.ts`（FilterExpr -> ORM/SQL）
- 修改 `packages/atoma-server/src/ops/opsExecutor/query.ts`
- 修改 `packages/atoma-server/src/adapters/ports.ts`（findMany 改为 Query）
- 修改 `packages/atoma-server/src/adapters/prisma/PrismaAdapter.ts`
- 修改 `packages/atoma-server/src/adapters/typeorm/TypeormAdapter.ts`
- 修改 `packages/atoma-server/src/adapters/shared/keyset.ts`（token 结构）

### Phase 5：清理与回归
- 移除旧 QueryParams/orderBy/fields/cursor 相关逻辑
- 更新文档与示例（README/Docs/Examples）
- 新增一致性测试（local/server 同 Query 结果一致）

## 最终结论
- 用 `Query + FilterExpr` 作为唯一入口，彻底统一语义与执行。
- 协议仍为 v=1，但结构直接替换旧定义。
- 本地、内存、IndexedDB、服务端共享同一 Query 语义与 cursor 规范。
