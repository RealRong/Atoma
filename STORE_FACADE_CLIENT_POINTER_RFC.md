# 方案提案：在 Store Facade 上增加 `client` 指针（让 hooks 仅凭 store 找到父 client/runtime）

## 背景

当前 `atoma-react` 的 hooks 需要订阅 store 快照、做 hydrate、解析 relations、读取 matcher/indexes 等运行时能力。但 `StoreApi` 的公开形状刻意只包含 CRUD（+可选 `findMany`），因此 hooks 无法从 `store` 反推出它属于哪个 `client/runtime`。

现状通过“第二通道”解决：在 store facade 上挂一个内部字段（通过 `STORE_INTERNAL` symbol）携带 `getHandle/resolveStore/writeback` 等能力。问题是：

- 使用 `Symbol.for(...)` 与跨包重复定义显得“协议丑且脆”
- react 包不得不触摸 handle/jotai 等内部结构并大量使用 `any`

## 目标 / 非目标

目标：

- hooks 仍然只接收 `store`（不引入 Provider 作为硬依赖，不要求每次显式传 `client`）
- 支持多 client 并存场景下的可靠归属判定（避免 `storeName` 冲突导致误解析）
- 尽量不“污染”面向普通用户的 `StoreApi` 类型（保持 CRUD 为主的直觉）

非目标：

- 本提案不要求把“订阅/快照/hydrate”做成 `StoreApi` 的正式方法
- 不在本提案中重构 hooks 以完全消除对内部实现的依赖（可作为后续优化）

## 核心思路

让 **store facade** 显式携带一个“归属 client”的指针：

- `client.stores.Todo.client === client`（示例）
- hooks 通过 `store.client` 得到 owner client/runtime，再去获取 store 的运行时能力（source/hydrate/relations/resolveStore 等）

这相当于把“第二通道”从“隐藏的 symbol 字段”提升为“显式 owner 指针”，使得归属关系可见且可验证。

## 提议的 API 形态

### Store Facade 运行时形状

- `store` 仍实现 `StoreApi<T, R>` 的全部 CRUD 方法
- 额外增加：
  - `store.name: string`（现有实现已有）
  - `store.client: AtomaClient`（新增）

> 注：这里的 `AtomaClient` 是一个抽象概念，实际可用 “最小能力接口” 替代，避免 hooks 获得过大的权限面（见下文）。

### 类型策略：对普通用户尽量“看不见”

保持 `StoreApi<T, R>` 不变（仍然只描述 CRUD），但对 `client.stores.*` 返回值使用更具体的类型：

- `StoreFacade<T, R> = StoreApi<T, R> & { readonly name: string; readonly client: ClientLike }`

其中 `ClientLike` 在类型层面只是“归属指针”的载体；bindings 不直接依赖 `client` 上的方法，而是通过 `atoma/internal` 导出的函数获取订阅源、hydrate、relations 等能力（见实施方案）。

这样做的效果是：

- 普通用户仍可把它当 `StoreApi` 用（CRUD 体验不变）
- 绑定层（atoma-react）可通过类型守卫/辅助函数安全访问 `store.client`

### 导出位置建议

为了避免用户误用 `.client` 做强依赖，可以把相关类型与辅助函数放到：

- `atoma/unstable`（推荐）

例如：

- `export type StoreFacade<...>`
- `export function isStoreFacade(x): x is StoreFacade<...>`
- `export function getOwningClient(store): ClientLike | undefined`

主入口 `atoma` 只保证 CRUD 类型与 client 基本能力，不强调 `.client`。

## hooks 使用方式（概念流程）

1) hooks 接收 `store`（用户侧不变）
2) hooks 读取 `store.client` 得到 owner client/runtime
3) 通过 owner client/runtime 获取 store 的订阅源、hydrate 能力、relations 解析所需的 store resolver
4) 若 `store.client` 不存在或类型不匹配，报错提示“store 不是由 client.stores.* 创建”或“混用了不同 client 的 store”

## 实施方案（一步到位，无兼容）

当前项目暂无外部用户包袱，本提案采用“一步到位”的破坏性改动策略：直接移除 `STORE_INTERNAL`（symbol 第二通道）相关写入与读取逻辑，统一改用 `store.client` 作为归属指针，并在 `atoma/internal` 提供框架无关的 bindings 函数集合（React/Vue/… 直接复用）。

### atoma（核心包）

- 在创建 store facade 时附加 `client` 指针：
  - `facade.client = thisClient`（或挂为不可枚举属性，避免调试输出噪音）
- 在 `atoma/internal` 导出 bindings 函数（框架无关），例如：
  - `getStoreSource(client, storeName)`
  - `hydrateStore(client, storeName, items)`
  - `getStoreMatcher(client, storeName)` / `getStoreRelations(client, storeName)`
  - `resolveStore(client, token)`
- 在 `createClient()` 内部注册 `client -> runtime` 映射（推荐 WeakMap），供 `atoma/internal` 函数反查 runtime
- 删除 `STORE_INTERNAL` symbol 的定义与写入（包括 `Symbol.for('atoma.storeInternal')` 这条路径）

### atoma-react（绑定包）

- 删除 `requireStoreInternal`/`STORE_INTERNAL` 读取逻辑（不再通过 symbol 从 store 上取内部对象）
- hooks 全面改为：
  - 从 `store.client` 获取 owner `client`
  - 直接调用 `atoma/internal` 导出的 bindings 函数拿到 source/hydrate/relations/resolveStore
- 类型层面：
  - hooks 的入参仍然接受 `StoreApi<T, R>`，但内部通过类型守卫断言为 `StoreFacade<T, R>`
  - 报错信息明确指出“store 必须来自 `client.stores.*`（因为需要 `store.client`）”

### 验收标准

- `atoma-react` 不再引用 `Symbol.for('atoma.storeInternal')` 或任何 `STORE_INTERNAL` 常量
- `atoma` 不再在 store facade 上写入 symbol 内部通道
- demo/示例中 `useStoreQuery/useRelations/useRemoteFindMany` 走通（订阅/查询/hydrate/relations 不回退到旧逻辑）

## 风险与对策

1) 用户开始依赖 `.client`

- 风险：`.client` 变成半公开 API，后续难以移除
- 对策：
  - `.client` 的类型暴露为 `ClientLike`（最小能力），而不是完整 client 实现
  - 将类型与辅助函数放在 `atoma/unstable`，主文档不宣传
  - 运行时仍然提供，但对外承诺“仅供 bindings/高级场景”

2) 多 client 混用

- 风险：用户把 A client 的 store 传给 B client 的 hooks 环境（如果未来引入 Provider/绑定式 hooks）
- 对策：用 `store.client` 做强校验，错误信息明确指出混用与 storeName

3) 循环引用/序列化问题

- 风险：store 上挂 client 形成对象图，调试输出更大；某些用户可能尝试序列化 store
- 对策：声明 store facade 不可序列化；必要时将 `client` 挂为不可枚举属性（实现层面决定）

## 与 Symbol 第二通道的对比

- `.client` 更直观：归属关系可见，错误更好提示
- `.client` 不需要跨包 symbol 协议，也不依赖 `Symbol.for`
- 仍然保留“StoreApi 对用户主要是 CRUD”的体验（类型上可隐藏）
- 代价是“对象形状多了一个字段”，需要管理用户误用风险

## 结论

在“不用 Provider、不让每个 hook 都显式传 client、且 StoreApi 仍保持 CRUD 直觉”的约束下，在 store facade 上增加 `client` 指针是最直接、可维护且多 client 场景可靠的方案。推荐配合：

- 最小能力 `ClientLike`（减少暴露面）
- `atoma/unstable` 导出类型/守卫/辅助函数（降低用户误用）
- 直接移除 symbol 第二通道（项目暂无用户包袱，一步到位）

实现上建议优先使用 `atoma/internal` 导出的 bindings 函数集合（而不是让 `client` 本身承载大量方法），以便 React/Vue/等框架绑定复用同一套底层能力。
