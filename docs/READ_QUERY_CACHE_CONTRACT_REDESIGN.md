# Read Query 最终架构设计（不做远端字段裁剪）

> 最终拍板：
> - **我们不做远端字段裁剪**（不支持通过查询下推 `select/include` 到后端）。
> - `Store` 只提供实体语义。
> - 缓存策略由读流程统一执行，不由查询结构推断。

---

## 1. 目标与约束

## 1.1 目标

1. 底层语义单一、可预测：同一 API 不出现“同名不同缓存行为”。
2. 去除隐式策略：不再依赖 `select/include` 推断是否写回缓存。
3. 保持职责清晰：
   - `core/store` 只管实体读取与写回。
   - `react/hook` 或业务层负责视图投影。

## 1.2 约束（本方案硬性）

1. 不做远端字段裁剪。
2. 不引入过渡兼容层（一步到位）。
3. 不在 `Store.query` 上保留投影语义。

---

## 2. 问题根因（现状）

当前歧义来自三点：

1. `Query` 结构里含 `select/include`，导致查询语义混合。
2. `ReadFlow` 用 `shouldSkipStore` 做隐式缓存策略判断。
3. 调用方无法从 API 名称判断一次 query 是否会写回缓存。

结论：根因不是实现细节，而是**契约层把“查什么”和“缓存怎么处理”耦合在一起**。

---

## 3. 最终最优架构（结论）

## 3.1 Store 层只保留实体查询

`Store<T>` 最终接口：

```ts
query(query: Query<T>, options?: StoreReadOptions): Promise<QueryResult<T>>
queryOne(query: Query<T>, options?: StoreReadOptions): Promise<QueryOneResult<T>>
```

其中 `Query<T>` 只允许：

- `filter`
- `sort`
- `page`

**不再包含**：

- `select`
- `include`

## 3.2 缓存策略固定规则

- `store.query/store.queryOne`：
  - `source=local`：返回实体数据。
  - `source=remote`：先 `writeback`，再写入 `StoreState`，返回写回后的实体视图。

即：**query 永远是“实体读取 +（必要时）缓存写回”**。

## 3.3 投影责任上移

任何字段裁剪/视图整形由调用端处理：

- Hook 层（`useQuery/useStoreQuery`）或业务层 `map/pick`。
- 不进入 `Store` 公共契约。

示例（概念）：

```ts
const rows = await store.query({ filter, sort, page })
const view = rows.data.map(x => ({ id: x.id, title: x.title }))
```

---

## 4. 为什么这是最优（而不是 `store.project`）

1. `Store<T>` 作为实体仓储接口更纯净，不混入 `unknown` 投影返回。
2. 缓存语义单义：query 就是实体读，不存在“看参数猜行为”。
3. 类型系统更稳定：不会在 core store 公共 API 引入投影歧义。
4. 维护成本更低：执行层、事件层、测试矩阵更简单。

---

## 5. 关系系统（relations）的边界

`useRelations`/relation include 是关系编排能力，不属于 `Store.query` AST。

## 5.1 保留

- hook 级 `include`（关系展开配置）继续存在。
- relation prefetch 继续允许 `filter/sort/page.limit`。

## 5.2 禁止

- relation include query 中的 `select/include`。
- 通过 relation prefetch 做字段裁剪。

---

## 6. 分层职责（最终）

## 6.1 core/store

- 实体查询/写入。
- canonical cache 管理。
- 不做 view projection 协议。

## 6.2 runtime/read flow

- 统一执行 query。
- 统一执行 remote writeback。
- 不根据查询字段做缓存策略分支。

## 6.3 client/react

- 组合 fetch policy。
- 本地数据投影与视图组装。
- relations include（hook 层语义）。

## 6.4 backend/server

- 始终返回实体结构（分页/排序/过滤可以保留）。
- 不支持 query 级字段裁剪协议。

---

## 7. 需要落地的契约修改

## 7.1 `atoma-types/core/query.ts`

- 删除 `Query.select`
- 删除 `Query.include`
- `Query` 保留为实体查询结构（filter/sort/page）

## 7.2 `atoma-runtime/src/runtime/flows/ReadFlow.ts`

- 删除 `shouldSkipStore`
- `query` remote 分支统一 writeback
- 去掉与 `select/include` 相关的缓存分支逻辑

## 7.3 relations 链路

- `atoma-core/src/relations/include.ts`：不再提取/合并 `select/include`
- `atoma-runtime/src/relations/prefetch.ts`：校验禁止 `select/include`

## 7.4 react hooks

- `useQuery/useRemoteQuery/useStoreQuery` 移除对 `Query.select` 的策略分支依赖。
- 需要“只要 ids/部分字段”时，在 hook 内或调用端做投影，不下推到 store query。

## 7.5 server/adapters（若已消费 `query.select`）

- 去除对 `query.select` 的处理逻辑。
- 保持 filter/sort/page 语义。

---

## 8. 迁移顺序（一步到位）

1. 类型收敛：先改 `Query` 定义，删除 `select/include`。
2. runtime 收敛：删 `shouldSkipStore`，固定 query writeback 规则。
3. relations 收敛：限制 include query 字段白名单。
4. react/hook 收敛：移除 `select` 驱动的 transient 分支，改为本地投影。
5. server 收敛：删除 `query.select` 解析。
6. 全仓 typecheck + 行为回归。

---

## 9. 验收标准

## 9.1 类型与构建

- `pnpm --filter atoma-types run typecheck`
- `pnpm --filter atoma-runtime run typecheck`
- `pnpm --filter atoma-client run typecheck`
- `pnpm --filter atoma-react run typecheck`
- `pnpm --filter atoma-server run typecheck`
- `pnpm typecheck`

## 9.2 行为矩阵

1. `store.query`（remote）后，缓存更新可被 `get/getMany/list` 观察到。
2. `store.query`（local）无额外副作用。
3. 传入旧 `select/include` 调用在编译期失败。
4. relation prefetch 中传 `select/include` 运行时报错。
5. hook 中 ids/视图结果仍可正常生成（通过本地投影而非后端裁剪）。

---

## 10. 对外口径（最终）

- `query` 只做实体查询。
- query 远端成功后会写回缓存。
- 不提供远端字段裁剪能力。
- 视图裁剪由调用端（hook/业务层）自行处理。

