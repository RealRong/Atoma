# src/shared 抽离指南

本仓库允许把跨模块复用的“纯工具代码”抽离到 `src/shared/`，以保持业务模块（例如 `src/core/mutation/...`、`src/sync/...`）文件简洁、可读，并避免同类逻辑在多处复制粘贴后逐步漂移。

## 目标与范围

`src/shared/` 适合放：

- **纯函数**（无副作用、无 IO、无全局状态修改）
- **稳定的、跨模块可复用的算法/规范化**（例如：稳定序列化、key 生成、简单校验/断言、轻量对象归一化）
- **对环境无依赖**（不依赖 DOM / Node 特性；也不依赖 store/runtime/adapter 实例）
- **依赖面窄**（优先只依赖 `#protocol` 的类型或极少数本地类型）

`src/shared/` 不适合放：

- 依赖 store handle、jotai、adapter、网络请求、定时器等运行时设施的逻辑
- 强业务语义且只在一个模块内使用的“内部实现细节”
- 任何需要引入 `src/core` / `src/sync` 互相依赖的东西（容易制造循环依赖）

## 放哪儿：shared vs protocol vs core internals

使用这个决策表：

- **协议层概念（Protocol）**：如果函数是“协议定义的一部分”，且 server/backend/client 都可能复用（例如：`WriteOptions` 的规范化/校验/编码规则），优先放 `src/protocol/` 并通过 `Protocol.*` 暴露。
- **跨模块纯工具（Shared）**：如果函数只需要类型支持、无运行时依赖、且 core/sync/react 可能都用到，放 `src/shared/`。
- **模块内私有实现（Internals）**：如果函数依赖 mutation pipeline、immer patches、store runtime 或只服务于某个具体流程，优先留在原模块目录下的 `internals`/同级文件中。

## 抽离流程（推荐）

以 `src/core/mutation/pipeline/persisters/Outbox.ts` 为例：

1. **盘点“工具代码”**：标出与业务流程无关的 helper（例如：`stableStringify`、`optionsKey`、`requireBaseVersion`、`upsertWriteOptions` 等）。
2. **全仓搜索重复**：确认是否在 `src/core/mutation/...`、`src/sync/...` 等处存在同名/同逻辑实现。
3. **确定“语义是否一致”**：
   - 同名不等于同语义（例如 `stableStringify` 可能存在不同的 undefined/cycle/function 处理策略）。
   - 如果语义不同，禁止强行合并；应改名区分用途（例如 `stableStringifyForKey` vs `stableStringifyForQuery`）。
4. **设计最小依赖签名**：
   - 入参尽量用 `unknown`/基础类型 + 明确返回值，避免把 `shared` 绑到 core 的复杂类型上。
   - 必须依赖类型时，优先依赖 `#protocol` 的类型（例如 `EntityId`、`WriteOptions`）。
5. **按领域拆文件**（不要大杂烩）：
   - `src/shared/stableKey.ts`：稳定 key/序列化相关（例如 `stableStringifyForKey`、`optionsKey`）
   - `src/shared/version.ts`：`baseVersion` 解析/断言（例如 `requireBaseVersion`、`resolveOptionalBaseVersion`）
   - `src/shared/entityId.ts`：`EntityId` 判定/转换（例如 `isEntityId`、`toEntityId`）
   - 只有在多个模块都需要时才新增文件；否则先留在模块内部。
6. **替换引用并保持行为不变**：
   - 抽离前后输出必须一致（尤其是 key 生成、错误消息、baseVersion 判定边界）。
   - 不要顺手“顺便优化语义”，先做纯重构（refactor-only）。
7. **补/改测试**：
   - 如果原逻辑已有测试覆盖，确保抽离后仍然通过。
   - 若没有直接测试，优先在现有测试风格中补最小覆盖（例如 key 生成/版本断言的边界条件）。

## 导出与引用约定

- `src/shared/` 内部文件以具名导出为主。
- `src/shared/index.ts` 作为 barrel 文件：新增 shared 工具时同步补导出。
- 使用方式统一为：`import { Shared } from '#shared'`，并通过 `Shared.<domain>.<fn>` 访问（例如 `Shared.key.optionsKey(...)`）。
- 如果未来需要外部用户使用 shared（不一定需要），再考虑是否从 `src/index.ts` 公开导出；默认 shared 可先作为内部实现细节。

## 常见陷阱（务必避开）

- **错误地复用 Query 的 stableStringify**：Query 侧的稳定序列化往往会过滤函数/处理循环引用；用于 key 分组时可能改变行为，导致 batch 分组/compaction 出现差异。
- **引入循环依赖**：`shared` 反向依赖 `core`/`sync`，再被它们引用时容易形成环。
- **隐式行为漂移**：baseVersion 的判定（例如必须 `> 0`）和错误文案属于契约的一部分，改动会影响排障与一致性。
