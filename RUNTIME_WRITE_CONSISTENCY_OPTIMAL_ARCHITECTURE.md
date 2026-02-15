# Runtime WriteConsistency 最优方案（V2 落地版）

更新时间：2026-02-15

## 1. 结论

写一致性应继续由 runtime 统一编排，不下放给插件自由拼流程。  
当前已把旧布尔语义命名收敛为短语义枚举：`base/commit`。

---

## 2. 命名（已落地）

```ts
type WriteBase = 'cache' | 'fetch'
type WriteCommit = 'confirm' | 'optimistic'

type WriteConsistency = Readonly<{
    base: WriteBase
    commit: WriteCommit
}>

type Consistency = Readonly<Partial<WriteConsistency>>
```

语义：

1. `base='cache'`：缓存缺失直接报错，不补读。
2. `base='fetch'`：缓存缺失允许先 query 补基线。
3. `commit='confirm'`：等待远端确认后再落地。
4. `commit='optimistic'`：先本地提交，失败回滚。

旧字段映射：

1. `implicitFetch=true` -> `base='fetch'`
2. `implicitFetch=false` -> `base='cache'`
3. `optimistic=true` -> `commit='optimistic'`
4. `optimistic=false` -> `commit='confirm'`

---

## 3. 写流程（固定 5 步）

1. `resolve`：解析最终一致性策略。
2. `base`：按 `base` 决策是否补读。
3. `plan`：构建 write entries。
4. `commit`：按 `commit` 执行 confirm/optimistic。
5. `settle`：统一收敛结果（当前行为为失败回滚并抛错）。

插件不能改这 5 步顺序。

---

## 4. 策略来源（当前实现）

从高到低：

1. `RouteSpec.consistency`
2. `ExecutionSpec.consistency`
3. `DEFAULT_CONSISTENCY`

默认值：

```ts
const DEFAULT_CONSISTENCY: WriteConsistency = {
    base: 'fetch',
    commit: 'optimistic'
}
```

---

## 5. 当前已完成改造

### 5.1 atoma-types

1. `packages/atoma-types/src/runtime/persistence.ts`
2. `Policy` -> `WriteConsistency`。
3. `implicitFetch/optimistic` -> `base/commit`。
4. 新增 `WriteBase`、`WriteCommit`、`Consistency`。

1. `packages/atoma-types/src/runtime/execution.ts`
2. `RouteSpec.policy` -> `RouteSpec.consistency`。
3. `ExecutionSpec.policy` -> `ExecutionSpec.consistency`。
4. `resolvePolicy` -> `resolveConsistency`。

1. `packages/atoma-types/src/runtime/index.ts`
2. 更新 `WriteConsistency` 相关导出。

1. `packages/atoma-types/src/client/plugins/contracts.ts`
2. 移除 `PluginRuntime.execution.resolveConsistency` 暴露（插件不参与一致性解析）。

### 5.2 atoma-runtime

1. `packages/atoma-runtime/src/execution/kernel/ExecutionKernel.ts`
2. `DEFAULT_POLICY` -> `DEFAULT_CONSISTENCY`。
3. `resolvePolicy` -> `resolveConsistency`。
4. 默认值改为 `{ base: 'fetch', commit: 'optimistic' }`。

1. `packages/atoma-runtime/src/runtime/flows/write/utils/prepareWriteInput.ts`
2. 读取 `consistency.base` 替换旧 `implicitFetch` 判断。

1. `packages/atoma-runtime/src/runtime/flows/write/commit/WriteCommitFlow.ts`
2. 读取 `consistency.commit` 替换旧 `optimistic` 判断。

### 5.3 atoma-client

1. `packages/atoma-client/src/client/composition/buildPluginContext.ts`
2. 移除 `runtime.execution.resolveConsistency` 对插件透出。

---

## 6. 命名检查结论

1. `Policy/resolvePolicy/implicitFetch/optimistic` 在当前一致性主链路已完成替换。
2. 新命名满足“短命名 + 行业可读 + 去冗余后缀”原则。
3. 目前系统里可直接收敛的命名点已完成。
