ATOMA 核心层协议与约束（稳定版）

目的
- 固化核心层内部协议，作为 plugin 扩展与维护的基线
- 明确哪些内容是“稳定不变”的，哪些可扩展
- 在“无兼容负担”前提下，直接收敛到最优架构

适用范围
- atoma-core / atoma-runtime / atoma-client / atoma-react
- 仅描述核心层内部协议（不影响对外 API）


1. StoreHandle 协议（内部句柄）

定义
- 位置：`atoma-types/src/runtime/handleTypes.ts`
- 作用：内部流程（read/write/transform/persist）共享的最小上下文

稳定字段（不可新增/修改语义）
- `state: StoreState<T>`
- `storeName: string`
- `relations?: () => any | undefined`
- `config: { defaultWriteStrategy?, hooks, idGenerator, dataProcessor }`

约束
- 不允许在 handle 上新增字段（避免跨层隐式耦合）
- 新能力必须通过：
  - `state` 扩展
  - `config` 扩展（仅限配置类）
  - runtime/context 传入


2. StoreState 协议（状态持有与提交）

定义
- 位置：`atoma-types/src/runtime/storeState.ts`
- 作用：状态快照读取、订阅、提交与 writeback

稳定字段
- `getSnapshot(): StoreSnapshot`
- `setSnapshot(next)`
- `subscribe(listener): () => void`
- `commit({ before, after, changedIds? })`
- `applyWriteback(args, options?)`
- `indexes: IndexesLike<T> | null`
- `matcher?: QueryMatcherOptions`

约束
- `commit` 需保证：
  - before/after 等价时不触发变更
  - changedIds 空集时不触发变更
  - commit 后索引状态一致
- `setSnapshot` 只负责通知，严禁嵌入业务逻辑


3. StoreBindings 协议（内部绑定）

定义
- 位置：`atoma-types/src/internal/storeBindings.ts`
- 作用：react/hooks 等内部层访问 store 的最小桥接

稳定字段
- `name`
- `cacheKey`
- `source { getSnapshot, subscribe }`
- `indexes`
- `matcher?`
- `relations?`
- `ensureStore`
- `hydrate?`

约束
- bindings 挂载在 store 对象上，Symbol 键：`STORE_BINDINGS`
- react 层只允许通过 bindings 访问内部能力
- 不得直接读取 runtime/handle


4. Runtime 协议（核心入口）

定义
- 位置：`atoma-types/src/runtime/runtimeTypes.ts`
- 作用：统一入口，负责编排读写/持久化/transform/registry

稳定字段
- `read / write / persistence / transform / stores / hooks / io / now`

约束
- runtime 是唯一上下文
- hooks 由 runtime 统一触发
- op/entry id 生成由各流程内部负责，不暴露为 runtime 公共字段


5. Plugin 协议（扩展边界）

目标
- 插件只扩展能力，不改变核心协议

约束
- 插件不直接依赖 `StoreHandle` 的内部细节
- 插件不处理策略解释（由 runtime 决定）
- 插件只提供执行能力（IO/持久化/同步等）


6. 核心层演进规则（强约束）

稳定规则
- StoreHandle / StoreState / StoreBindings / Runtime 的语义保持稳定
- 允许在明确收益下进行破坏式重构，但必须保持职责边界清晰
- 默认不保留兼容层、不引入过渡别名

禁止规则
- 禁止新增 handle 字段
- 禁止绕过 bindings 访问内部状态
- 禁止 plugins 修改 runtime 内部状态


7. 变更流程（建议）

如需修改协议：
1) 先在文档中说明变更意图
2) 说明对 plugin/react/runtime 的影响
3) 给出一步到位目标结构与迁移顺序（不保留兼容路径）


8. 快速检查清单（日常维护）

- 是否新增了 handle 字段？（禁止）
- 是否绕过 bindings 直接访问内部状态？（禁止）
- 是否将策略判断移到了 plugin？（禁止）
- 是否在 StoreState 中嵌入业务逻辑？（禁止）
- 是否引入了兼容层/别名导出？（默认禁止）
