# 方案提案：用「模块导出的 Symbol 常量」替换 `Symbol.for('atoma.storeInternal')`

## 背景

当前 `atoma-react` 的 hooks 需要从 `store` 读取一些“非 CRUD”的运行时能力（订阅/快照、索引、matcher、writeback、relations、resolveStore 等）。为了不把这些能力做成用户可见的 `StoreApi` 方法，目前采用了“第二通道”：

- 在 `atoma` 侧把内部对象挂到 `store` facade 上（`facade[STORE_INTERNAL] = {...}`）
- 在 `atoma-react` 侧用 `requireStoreInternal(store, tag)` 读取该字段
- key 使用 `Symbol.for('atoma.storeInternal')`

痛点：

- `Symbol.for('...')` 依赖全局注册表，读起来“丑”，也让人误以为这是公共契约
- `atoma-react` 侧为了兼容/解构内部对象，被迫大量 `any`，实现细节外泄（Jotai store/atom、indexes、matcher 等）
- key 在两个包里各写一份，跨包对齐靠字符串约定，容易让人不安心

## 目标 / 非目标

目标：

- 仍然保持对用户来说的 `StoreApi` 是纯 CRUD（+可选 findMany），不新增用户日常会用到的方法
- hooks 仍然只接收 `store`（不要求每次显式传 `client`，也不引入 Provider 作为硬依赖）
- 把“第二通道”的 key 变为 **从 `atoma` 统一导出的 Symbol 常量**，让 `atoma-react` 通过 import 获取同一份 key
- 允许平滑迁移：在一段版本窗口内兼容旧的 `Symbol.for` key

非目标：

- 这份提案不解决“hooks 依赖内部实现细节太多”的全部问题（那属于更大的重构：把 hooks 所需能力收敛成更小的 bridge）
- 不在本提案中引入 Provider、多 client 注入、或 hooks factory（另案讨论）

## 核心思路

用“模块导出的 Symbol 常量”代替 `Symbol.for`：

- 在 `atoma` 包内定义并导出一个 Symbol 常量（例如 `export const STORE_INTERNAL = Symbol('atoma.storeInternal')`）
- `atoma` 在创建 store facade 时，使用这个常量作为 property key：`facade[STORE_INTERNAL] = internalBridge`
- `atoma-react` 直接 `import { STORE_INTERNAL } from 'atoma/…'`，然后读取 `store[STORE_INTERNAL]`

这样做的关键收益：

- key 的“来源”变得明确：它属于 `atoma`，而不是一个散落在各处的魔法字符串
- `atoma-react` 不再需要在自己的包里硬编码字符串（减少协议重复与对齐焦虑）
- 后续如果要进一步把内部对象收敛成更小的 bridge，也能以这个 symbol 为唯一入口推进

## API 形态（推荐）

由于我们不希望把这个通道当成“普通用户 API”，建议把导出放到一个明确的子路径中：

选项 A（推荐）：`atoma/unstable`

- `atoma` 新增入口：`atoma/unstable`
- 导出：
  - `STORE_INTERNAL`（Symbol 常量）
  - （可选）`getStoreInternal(store)` / `requireStoreInternal(store, tag)` 这类 helper，避免 react 包自己写类型断言

选项 B：`atoma/internal`

- 更强烈暗示“仅供框架绑定/内部包使用”
- 缺点是打包器/TS path 配置上更容易踩坑（以及用户可能还是会 import）

不推荐：直接从 `atoma` 主入口导出该 symbol（会被误认为稳定公共 API）。

## 类型与边界（最低限度契约）

为了避免把 runtime handle 的具体结构泄漏给 `atoma-react`，建议 symbol 对应的值不是“handle 本体”，而是一个 **最小能力桥接对象**（bridge）。

最小桥接能力可以沿用现状（只描述行为，不暴露具体实现类型）：

- `storeName: string`
- `resolveStore(name: StoreToken): StoreApi<any, any>`
- `getHandle(): unknown`（或返回一个受控的 `StoreHandleLike`，但尽量不要把 Jotai 类型外泄给 react）
- `writeback(handle: unknown, item: unknown): Promise<unknown>`

迁移阶段可以先保持现状类型（以减少改动），但中长期建议把 `atoma-react` 依赖的字段从 `handle.jotaiStore/atom/indexes/matcher` 收敛成更稳定的 bridge 方法，例如：

- `getSource(): { getSnapshot; subscribe }`
- `getMatcher(): unknown`
- `applyWritebackAndUpdateIndexes(items): Promise<void>`（把 hydrate 逻辑集中到 atoma）

这属于后续优化，不是本提案的硬要求。

## 兼容性与迁移策略（强烈建议做）

如果直接从 `Symbol.for` 切到“模块导出 symbol”，会引入一个现实风险：**同一个应用中出现多份 atoma 实例** 时，import 得到的 symbol 不是同一个引用，读取会失败（而 `Symbol.for` 在这种情况下仍然能命中同一个全局 symbol）。

因此建议采用“两阶段兼容”：

阶段 1（兼容期，建议至少 1 个小版本周期）：

- `atoma` 在 facade 上同时写入两个 key：
  - 新 key：`facade[STORE_INTERNAL] = bridge`
  - 旧 key：`facade[Symbol.for('atoma.storeInternal')] = bridge`
- `atoma-react` 的读取逻辑按顺序尝试：
  - 先读新 key（import 得到的 `STORE_INTERNAL`）
  - 再 fallback 读旧 key（`Symbol.for(...)`）以兼容旧 atoma 或多份 atoma

阶段 2（清理期）：

- `atoma-react` 最终只保留新 key（或仍保留 fallback，但把它标记为“兼容旧版本/多份实例”的容错）
- `atoma` 侧视情况移除旧 key 的写入（如果我们确信生态不会频繁出现多份 atoma）

说明：是否永久保留 fallback，取决于你们对“多份 atoma”这一类安装问题的容忍度。保留 fallback 代价很低，但会让“Symbol.for 的阴影”长期存在。

## 文件/模块改动清单（按推荐做法）

在 `atoma`：

- 新增（示例）：
  - `packages/atoma/src/unstable/storeInternal.ts`
    - `export const STORE_INTERNAL = Symbol('atoma.storeInternal')`
    - `export type StoreInternalBridge = ...`
    - （可选）`export function requireStoreInternal(...)`
- 新增 `atoma/unstable` 的导出入口（例如 `packages/atoma/src/unstable/index.ts` 并在构建/exports 映射中声明）
- `ClientRuntimeStores` 里把 `const STORE_INTERNAL = Symbol.for(...)` 替换为 import 的 `STORE_INTERNAL`
- 兼容期内额外写入旧 key：`facade[Symbol.for('atoma.storeInternal')] = facade[STORE_INTERNAL]`

在 `atoma-react`：

- `packages/atoma-react/src/hooks/internal/storeInternal.ts`
  - 从 `atoma/unstable` import `STORE_INTERNAL`（或 import `requireStoreInternal` helper）
  - 兼容读取旧 key（若需要兼容期策略）

## 风险与应对

1) 多份 atoma 实例（依赖树里出现多个版本或未被打包器去重）

- 风险：新方案下 symbol 不对齐导致读取失败
- 应对：
  - 兼容期保留 `Symbol.for` fallback
  - `atoma-react` 报错信息里提示“可能安装了多个版本 atoma / bundler 未去重”
  - 在 `atoma-react` 的 peerDependencies/依赖策略上尽量推动单实例（视包管理策略而定）

2) ESM/CJS + 打包器 tree-shaking/exports 映射

- 风险：`atoma/unstable` 子路径导出需要正确配置 package exports/tsup entry
- 应对：在构建配置里显式声明 entry，并补上类型声明输出

3) 用户误用内部通道

- 风险：用户直接 import `atoma/unstable` 并依赖内部行为
- 应对：
  - 命名 `unstable`/`internal` 明确告知不稳定
  - 文档不在主 README 宣传，仅在绑定层使用

## 测试/验证建议

- 单元测试：
  - `atoma-react` 的 `requireStoreInternal` 在新旧 key 下都能命中
  - 当 store 不是来自 `client.stores.*` 时能给出明确错误
- 集成验证：
  - demo/示例跑一遍 `useStoreQuery/useRelations/useRemoteFindMany` 基本链路
  - 模拟“多份 atoma”场景（可用 pnpm overrides/lockfile 人工造一个双版本）确保 fallback 仍能工作（若启用兼容策略）

## 结论

这套方案保留了“store 对用户只暴露 CRUD”的直观体验，同时把第二通道的协议从“全局字符串 + 重复定义”提升为“由 atoma 统一导出的 key”，并通过兼容策略把 `Symbol.for` 的历史包袱降到最低。

