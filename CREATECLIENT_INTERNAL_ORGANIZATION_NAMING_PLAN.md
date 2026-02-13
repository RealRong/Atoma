# `createClient` 内部组织与命名优化方案

> 范围：`packages/atoma-client/src/createClient.ts` 及其直接装配链路  
> 目标：在不引入“组件爆炸”的前提下，把 `createClient` 收敛为清晰的 Composition Root，并统一命名到行业通用语义。

---

## 1. 当前问题（基于现状）

当前 `createClient.ts` 同时承担了：

1. 入参归一化
2. runtime 创建
3. plugin context / runtime api 组装
4. operation client 创建与 capability 注册
5. debug/direct strategy 安装
6. disposer 生命周期管理
7. client 对象导出

这导致两个问题：

- **文件职责过密**：Composition、Facade 构造、系统安装、生命周期管理混在一个函数内。
- **命名层级不一致**：`context/runtimeApi/runtimeExtension/*` 历史词汇并存，增加理解成本。

---

## 2. 优化目标

1. `createClient` 只保留“编排顺序”，不承载细节实现。
2. 命名统一到行业常用范式：`normalize / build / create / setup / install / register / dispose`。
3. 插件统一使用单一模型；`runtime` 可作为 API 使用，但不暴露“接线权”。
4. 不新增复杂抽象类；优先使用小函数与对象字面量。

---

## 3. 行业规范命名基线（建议作为本链路约束）

## 3.1 动词语义（必须统一）

- `normalizeX`：输入归一化/容错
- `buildX`：从已有依赖拼装值对象（无副作用）
- `createX`：创建实例（通常有状态）
- `setupX`：装配一个子系统（可含注册）
- `installX`：向现有系统挂载能力（返回卸载函数）
- `registerX`：向 registry/capability 写入条目

## 3.2 名词语义（必须区分）

- `Api`：对外可调用能力集合（如 `ctx.runtime` 能力面）
- `Context`：调用时上下文（含能力引用）
- `Facade`：受限代理面（边界收口，仅用于内部实现描述）
- `Assembly`：某子系统的装配结果（常含 `dispose`）
- `Disposer`：单个清理函数

## 3.3 插件边界语义（本方案核心）

- 插件统一使用 **一个 `ClientPlugin` 模型**。
- `ctx.runtime` 对插件可见，且它是 **唯一运行时能力面**（受限能力，不可接线）。
- 不再保留 `RuntimeExtensionFacade` 与 `PluginRuntimeApi` 双定义；统一收敛到 `PluginContext.runtime`。
- 明确不暴露：
  - `hooks.register` / `hooks.emit`
  - `strategy.register` / `strategy.setDefault`
  - 任何非插件生命周期的中间件注册入口
- 中间件与事件注册只允许通过：
  - `operations(ctx, register)` 的 `register`
  - `events(ctx, register)` 的 `register`

## 3.4 变量命名规则

- 集合优先使用**自然复数名**，避免机械 `*List` 后缀（如 `plugins`、`disposers`）
- 仅在确有区分价值时使用 `*Map`（如 `capabilityMap`）
- 卸载函数集合统一使用：`disposers`
- 布尔状态不做机械改名；`disposed` 与 `isDisposed` 均可，优先沿用现有清晰命名

---

## 4. 命名优化建议（针对当前链路）

## 4.1 命名取舍原则（短而清晰）

- 公开契约名（types / exports）优先完整词：`operation`、`runtime`、`context`
- 文件内局部变量可适度缩短：`opClient`、`pipeline`
- 不引入难懂缩写：避免 `ctx2`、`rtx`、`plgAsm`
- 以“读一眼能猜职责”为第一目标，再追求字符数

## 4.2 立刻可改（低风险，优先）

| 当前 | 建议 | 说明 |
|---|---|---|
| `opt` | `options` | 避免缩写，通用可读 |
| `input` | `resolvedOptions` | 比 `normalizedOptions` 更短，语义仍清晰 |
| `capabilities` | `capabilities`（保留） | 现有语义已清晰，且与现有调用面一致 |
| `runtimeApi` / `runtimeExtension` | `runtime` | 单一运行时入口，避免双模型词汇 |
| `context` | `context`（保留） | 在 `createClient` 作用域内语义明确，无需额外前缀 |
| `operationPipeline` | `pipeline` | 当前函数内无歧义，短且清晰 |
| `operationClient` | `opClient` | 行业内常见缩写，可读性可接受 |
| `pluginInitDisposers` | `initDisposers` | 去冗余前缀，保持复数集合语义 |
| `disposers` | `disposers`（保留） | 你偏好的最简清晰命名 |
| `disposed` | `disposed`（保留） | 当前命名已清晰，无需机械改名 |

## 4.3 后续可改（中风险，分批）

| 当前 | 建议 | 说明 |
|---|---|---|
| `RuntimeExtensionContext` + `PluginContext` | 单一 `PluginContext` | 去双模型，降低分支复杂度 |
| `RuntimeExtensionPlugin` + `ClientPlugin` | 单一 `ClientPlugin` | 保留一套插件契约即可 |
| `RuntimeExtensionFacade` + `PluginRuntimeApi` | 单一 `PluginRuntime`（挂在 `ctx.runtime`） | 去重复能力面，减少维护点 |
| `runtimeExtension` / `runtimeApi` 字段 | `runtime`（受限 API） | 语义直观，统一入口 |
| `AnyClientPlugin` | 删除 | 单模型后不再需要 union 类型 |
| `registerOperations` | `registerOps`（内部） | 仅内部变量可缩写；对外类型仍保留完整词 |

> 备注：对外导出的 API/类型名尽量不要用 `op*` 缩写，缩写只建议用于函数内部局部变量。

---

## 5. 内部代码组织优化（不引入新组件爆炸）

建议拆成 4 个轻量文件（函数级拆分，不增加类层级）：

1. `src/client/composition/normalizeCreateClientOptions.ts`
2. `src/client/composition/buildPluginContext.ts`
3. `src/client/composition/installClientSystems.ts`
4. `src/createClient.ts`（仅保留编排）

## 5.1 各文件职责

- `normalizeCreateClientOptions.ts`
  - 输入：`CreateClientOptions`
  - 输出：`{ schema, plugins }`
  - 只做容错/默认值，不访问 runtime

- `buildPluginContext.ts`
  - 输入：`runtime`, `capabilities`
  - 输出：`context`
  - 构建 `ctx.runtime` 单一受限能力面（不暴露 hooks/strategy 注册）

- `installClientSystems.ts`
  - 输入：`runtime`, `pipeline`, `capabilities`, `plugins`
  - 输出：`disposers`
  - 负责 install/register 相关副作用

- `createClient.ts`
  - 只负责调用顺序与返回 client
  - 行数目标：< 90 行

## 5.2 目标编排形态（伪代码）

```ts
export function createClient(options) {
    const resolvedOptions = normalizeCreateClientOptions(options)

    const capabilities = new CapabilitiesRegistry()
    const runtime = createRuntime(resolvedOptions.schema)
    const pipeline = new OperationPipeline()

    const context = buildPluginContext({ runtime, capabilities })

    const plugins = setupPlugins({
        context,
        rawPlugins: resolvedOptions.plugins,
        operationPipeline: pipeline,
    })

    const disposers = installClientSystems({
        runtime,
        pipeline,
        capabilities,
        plugins,
    })

    return createClientHandle({ runtime, plugins, disposers })
}
```

---

## 6. 具体重构顺序（低风险）

1. **先改命名，不改行为**：仅变量名与函数名收敛。
2. 抽出 `normalizeCreateClientOptions`（纯函数，零风险）。
3. 抽出 `buildPluginContext`（确保 typecheck 先绿）。
4. 抽出 `installClientSystems`（把副作用集中）。
5. 最后把 `createClient.ts` 压缩为编排函数。

---

## 7. 验收标准

1. `createClient.ts` 不再包含 facade 细节构造代码。
2. `createClient.ts` 变量命名全部符合第 4.1 映射。
3. 插件上下文模型统一为单一 `PluginContext`，且仅保留 `ctx.runtime`。
4. 全仓 `pnpm typecheck` 通过。
5. 无新增兼容别名、双轨接口或双 runtime 能力模型。

---

## 8. 一句话结论

`createClient` 最优形态应是**薄编排 + 外部小函数装配**；命名以 `normalize/build/create/setup/install` 为主轴，把“对象是什么、在做什么、处于哪一层”直接编码进名字，长期维护成本会显著下降。
