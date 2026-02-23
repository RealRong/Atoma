# Relations 体系最终重构方案（Core/Runtime 单实现收敛）

## 1. 结论先行

在“无兼容成本、一步到位”的前提下，relations 的最优架构是：

1. `atoma-types/core` 定义唯一关系契约（包含 include/query 语义）。
2. `atoma-core/relations` 只保留纯算法与纯数据规划（plan/merge/key/path），不做 runtime schema 编译。
3. `atoma-runtime/relations` 只执行 prefetch/project，不再重复解析/校验 include query。
4. `atoma-react` 只负责 hook 编排，不再维护独立的 include 解析实现。
5. 全链路去掉 `unknown`/`any` 透传，恢复从 `Store<T, Relations>` 到 `useRelations/useQuery` 的强类型闭环。

---

## 2. 当前问题（代码事实）

## 2.1 类型链路断裂（高优先级）

1. `packages/atoma-types/src/runtime/schema.ts` 中 `relations?: Record<string, unknown>`。
2. `packages/atoma-types/src/runtime/store/handle.ts` 中 `relations?: () => unknown | undefined`。
3. `packages/atoma-types/src/internal/storeBindings.ts` 中 `relations?: () => unknown | undefined`。
4. 上层因此大量断言：
   - `packages/atoma-react/src/hooks/useQuery.ts`
   - `packages/atoma-react/src/hooks/useRelations.ts`
   - `packages/atoma-react/src/hooks/internal/relationInclude.ts`

结论：关系类型在 runtime/react 实现层基本失效。

## 2.2 include/query 语义存在多套实现（高优先级）

1. `packages/atoma-core/src/relations/include.ts`：提取与合并 include query。
2. `packages/atoma-runtime/src/relations/prefetch.ts`：再次校验 include query page。
3. `packages/atoma-react/src/hooks/internal/relationInclude.ts`：再次解析 include 选项（`live/prefetch`）。

结论：同一输入被多次解析，规则漂移风险高。

## 2.3 Core 承担了 runtime schema 编译职责（中高优先级）

1. `packages/atoma-core/src/relations/compile.ts` 负责 schema 运行时校验和编译。
2. 实际调用方只有 `packages/atoma-runtime/src/store/Factory.ts`。

结论：`compileRelationsMap` 应下沉到 runtime（schema 装配层），不应留在 core。

## 2.4 relation query 与 store query 边界不够清晰（中高优先级）

1. 当前大量使用 `Query<unknown>` 表达 relation include query（plan/prefetch）。
2. relation 仅支持 `filter/sort/page.limit`，却仍复用完整 Query 结构并在运行期限制。

结论：应引入独立 `RelationQuery`，避免在 relation 语义中套用完整 store query。

## 2.5 React relations 编排复杂度偏高（中优先级）

`packages/atoma-react/src/hooks/useRelations.ts` 同时维护：

1. include 归一化。
2. prefetch 去重与完成标记。
3. relation store tokens/state 缓存。
4. snapshot/live 双通道投影。

并伴随 `Record<string, unknown>` 与断言，增加维护复杂度。

---

## 3. 重构目标（最终态）

1. **单一契约**：relation 相关输入与执行规格只定义一次。
2. **单一解析**：include 只在一个模块归一化，其他层只消费归一化结果。
3. **单一规划**：core 只产出一个统一 plan，runtime prefetch/project 共用。
4. **单一类型链路**：`Store<T, Relations>` 的关系类型可传到 runtime bindings 与 react hooks。
5. **职责纯化**：
   - core：算法和数据结构
   - runtime：执行编排
   - react：UI/hook 编排

---

## 4. 最终契约设计（atoma-types）

## 4.1 新增 RelationQuery（替代 relation 场景下的 Query<unknown>）

建议在 `packages/atoma-types/src/core/relations.ts` 收敛为：

1. `RelationQuery<T>` 只包含：
   - `filter?: FilterExpr<T>`
   - `sort?: SortRule<T>[]`
   - `limit?: number`
2. `RelationIncludeOptions<T, Include>` 包含：
   - `query?: RelationQuery<T>`
   - `live?: boolean`
   - `prefetch?: 'on-mount' | 'on-change' | 'manual'`

说明：

1. relation query 语义独立于 store query 分页模型（不再使用 `page` 包裹 limit）。
2. relation include 内不再承载 `select/include`（与既有 read-query 决策一致）。

## 4.2 类型链路打通（去 unknown）

1. `runtime/store/handle.ts`
   - `relations?: () => RelationMap<T> | undefined`
2. `internal/storeBindings.ts`
   - `StoreBindings<T, Relations>`
   - `relations?: () => RelationMap<T> | undefined`
   - `getStoreBindings<T, Relations>(store: Store<T, Relations>, ...)`
3. `runtime/schema.ts`
   - relations 类型不再使用裸 `Record<string, unknown>`，统一引用一套关系 schema 类型（见 4.3）。

## 4.3 统一 schema 类型来源

当前 `client/relations.ts` 与 `runtime/schema.ts` 脱节。建议：

1. 将关系 schema 类型抽到公共层（建议 `atoma-types/core` 下的新文件）。
2. `atoma-types/client` 与 `atoma-types/runtime` 同时复用该类型。
3. 运行时编译只做值校验，不再通过 `unknown` 丢失结构信息。

---

## 5. Core/Runtime 单实现收敛方案

## 5.1 Core：只保留“规划与算法”

`packages/atoma-core/src/relations` 最终职责：

1. builders（`belongsTo/hasMany/hasOne/variants`）。
2. include 归一化与 query 合并（单入口）。
3. key/path 提取与键集合归并。
4. **统一 plan 生成**（prefetch/project 共用一套结构）。

建议将当前 `buildPrefetchPlan` + `buildProjectPlan` 合并为一套 `buildRelationPlan`（或语义等价结构），避免双轨。

## 5.2 Runtime：只执行，不再重复解析校验

`packages/atoma-runtime/src/relations` 最终职责：

1. `prefetch.ts`：
   - 仅消费 core 输出的标准 plan。
   - 仅负责执行策略（并发、超时、错误策略、调用 `store.getMany/query`）。
   - 删除 `validateIncludeQuery` 这类重复校验。
2. `project.ts`：
   - 仅消费标准 plan + storeStates 执行投影。
   - 不再自行理解 include 原始结构。

## 5.3 compileRelationsMap 下沉到 runtime

1. 从 `atoma-core/relations` 移除 `compile.ts` 与相关导出。
2. 在 `packages/atoma-runtime/src/store/` 下实现 `compileRelations`（名称可再定）。
3. `Factory.ts` 直接引用 runtime 本地编译器。

理由：schema 编译属于 runtime 装配职责，不属于 core 领域算法职责。

---

## 6. 可复用基础设施清单（避免多套实现）

## 6.1 已有可直接复用

1. `atoma-core/query.runQuery`
   - 已用于 runtime relation project 排序+limit。
   - 保持单实现，不新增“relation 专用排序分页器”。
2. `atoma-core/relations/key.ts`
   - 继续作为 key 解析唯一来源（`extractKeyValue/collectUniqueKeys`）。
3. `atoma-core/relations/path.ts`
   - 继续作为路径读取基础能力唯一来源。

## 6.2 建议新增共享基础工具（atoma-shared）

当前有重复低阶逻辑（`isRecord`、非负整数归一化）散落于 core/runtime/react。建议新增并统一复用：

1. `isPlainRecord(value: unknown): value is Record<string, unknown>`
2. `normalizeNonNegativeInt(value: unknown): number | undefined`

落点建议：

1. 新增到 `packages/atoma-shared/src/`。
2. `atoma-core/src/relations/include.ts`
3. `atoma-runtime/src/relations/prefetch.ts`
4. `atoma-react/src/hooks/internal/relationInclude.ts`（若文件保留）

---

## 7. 关键重构项（按 CODE_SIMPLIFIER 模板）

## 7.1 项目 A：relation query 契约独立化

- 问题：
  - relation 语义复用 `Query<unknown>`，并在 runtime 再次做白名单校验，模型不清晰。
- 修改建议：
  - 引入 `RelationQuery`，relation include 仅表达 `filter/sort/limit`。
- 收益：
  - 语义清晰；去掉重复校验层；减少 `Query<unknown>` 断言。
- 风险：
  - relation include 写法会有一次性破坏（`page.limit -> limit`）。
- 验证方式：
  - `pnpm --filter atoma-types run typecheck`
  - relation include 旧写法应在编译期报错。

## 7.2 项目 B：compile 下沉 runtime

- 问题：
  - core 持有 runtime schema 编译职责，违反层次边界。
- 修改建议：
  - 移动 `compileRelationsMap` 到 runtime/store。
- 收益：
  - core 更干净；runtime 装配职责闭合。
- 风险：
  - 导出路径变化会影响调用点。
- 验证方式：
  - `pnpm --filter atoma-core run typecheck`
  - `pnpm --filter atoma-runtime run typecheck`

## 7.3 项目 C：include 单入口归一化

- 问题：
  - core/runtime/react 三处解析同一 include 结构。
- 修改建议：
  - core 输出标准化 include 结果与 relation plan；runtime/react 仅消费。
- 收益：
  - 消除规则漂移；减少重复逻辑与重复 bug 修复成本。
- 风险：
  - `useRelations` 需重接入计划结构。
- 验证方式：
  - 关系 prefetch/project 结果回归（belongsTo/hasOne/hasMany/variants）。

## 7.4 项目 D：StoreBindings/Handle 关系类型打通

- 问题：
  - 关系类型在 runtime internal 被 `unknown` 吞掉，react 端只能 `as`。
- 修改建议：
  - `StoreBindings`/`StoreHandle` 改为泛型化 relations 返回类型。
- 收益：
  - `useQuery/useRelations` 去断言；include 类型提示恢复。
- 风险：
  - internal 类型变动涉及多个包联动。
- 验证方式：
  - `pnpm --filter atoma-react run typecheck`
  - `pnpm --filter atoma-client run typecheck`

## 7.5 项目 E：react relations 编排减负

- 问题：
  - `useRelations` 集成了过多“解析 + 执行细节”。
- 修改建议：
  - 保留编排职责，移除本地解析重复逻辑，消费 core 计划结果。
- 收益：
  - hook 代码体量与状态分支下降，可读性提升。
- 风险：
  - hook 行为时序需要回归（prefetch mode/live/snapshot）。
- 验证方式：
  - 关键 hooks 行为测试与 demo 手工验证。

---

## 8. 一步到位迁移顺序（推荐执行顺序）

1. **类型先行**：
   - 引入 `RelationQuery`、调整 `RelationIncludeOptions`。
   - 打通 `StoreHandle/StoreBindings/runtime schema` 关系类型。
2. **core 收敛**：
   - include 归一化单入口。
   - prefetch/project plan 合并为单一计划模型。
3. **runtime 收敛**：
   - compile 下沉。
   - `prefetch.ts` 移除重复校验，按 plan 执行。
4. **react 收敛**：
   - `useRelations` 消费统一 plan。
   - 清理 `any/unknown` 断言与重复 include 解析代码。
5. **清理旧实现**：
   - 删除不再使用的 helper/类型/导出。
   - 删除过渡 API，不保留兼容别名。

---

## 9. 文件级改造清单（目标态）

## 9.1 atoma-types

1. `packages/atoma-types/src/core/relations.ts`
2. `packages/atoma-types/src/runtime/schema.ts`
3. `packages/atoma-types/src/runtime/store/handle.ts`
4. `packages/atoma-types/src/internal/storeBindings.ts`
5. 关系 schema 公共类型文件（新增）

## 9.2 atoma-core

1. `packages/atoma-core/src/relations/include.ts`
2. `packages/atoma-core/src/relations/plan.ts`
3. `packages/atoma-core/src/relations/index.ts`
4. `packages/atoma-core/src/relations/compile.ts`（删除）

## 9.3 atoma-runtime

1. `packages/atoma-runtime/src/store/Factory.ts`
2. `packages/atoma-runtime/src/store/`（新增 compileRelations 文件）
3. `packages/atoma-runtime/src/relations/prefetch.ts`
4. `packages/atoma-runtime/src/relations/project.ts`

## 9.4 atoma-react

1. `packages/atoma-react/src/hooks/useRelations.ts`
2. `packages/atoma-react/src/hooks/useQuery.ts`
3. `packages/atoma-react/src/hooks/internal/relationInclude.ts`（合并/删除，视最终落点而定）

## 9.5 atoma-shared（可选但强烈建议）

1. 新增对象判断与数字归一化基础工具文件。

---

## 10. 验收标准

## 10.1 类型与构建

1. `pnpm --filter atoma-types run typecheck`
2. `pnpm --filter atoma-core run typecheck`
3. `pnpm --filter atoma-runtime run typecheck`
4. `pnpm --filter atoma-client run typecheck`
5. `pnpm --filter atoma-react run typecheck`
6. `pnpm typecheck`

## 10.2 行为矩阵

1. `belongsTo`：`id` 快路径与非 `id` 索引/扫描路径行为一致。
2. `hasMany/hasOne`：排序、limit、去重行为一致。
3. `variants`：分支匹配后 prefetch/project 行为一致。
4. `prefetch`：`on-mount/on-change/manual` 策略行为一致。
5. relation include 仅接受约定字段；非法结构在统一入口报错。

---

## 11. 口径统一（重构完成后）

1. relations 使用一套类型、一套 include 归一化、一套 plan。
2. core 只做关系算法与规划，不做 runtime schema 装配。
3. runtime 只执行计划，不重复理解原始 include。
4. react 只做 hook 编排，不维护独立 include 解析规则。
5. 不保留兼容层，不保留旧命名双轨。

