# Writeback 最优架构建议（不在乎重构成本）

目标：以**最优架构**为优先，不考虑兼容层与重构成本，明确 `transform.writeback`、hooks、`applyWriteback` 的职责与契约，从而支持批量/并行优化与可维护性。

## 核心原则

- **单一职责**：数据变换与副作用彻底分离。
- **确定性**：writeback 的输出只由输入决定（可重放、可并行、可批量）。
- **唯一写入点**：所有本地状态变更只在 `applyWriteback` 发生。
- **副作用集中**：事件、日志、通知、订阅只在 hooks 中发生。

## 职责边界

### 1) transform.writeback（纯函数、无副作用、顺序无关）

**职责**
- 处理服务端返回数据的归一化、字段修正、版本字段补齐、结构转换等“纯数据”动作。
- 可选做 schema validate、sanitize、serialize 等数据处理管线。

**禁止事项**
- 不写本地缓存、不发事件、不访问全局可变状态。
- 不依赖前一个 writeback 的执行结果（顺序无关）。

**契约**
- 输入相同，输出必须一致。
- 不可产生外部可观察副作用。

**建议接口**
- `writeback(item)` 必须是纯函数。
- 可选提供 `writebackMany(items)`：在需要聚合/去重/批处理时，显式声明批量语义。

### 2) applyWriteback（唯一的本地状态写入点）

**职责**
- 负责将 writeback 结果写入 store、索引、版本号等内部结构。
- 允许内部优化（比如合并批次、去重、跨实体写入规划）。

**约束**
- 不能做网络 IO、业务事件通知、日志上报等副作用。
- 只消费 `StoreWritebackArgs`，不直接处理原始服务端数据。

### 3) hooks（副作用集中区）

**职责**
- 事件通知、日志、metrics、订阅、外部插件联动等全部副作用放到 hooks。
- 使用明确生命周期事件（如 writeStart、writeCommitted、writeFailed、writePatches 等）。

**约束**
- hooks 仅观察，不参与写入逻辑。
- 不应改变 writeback 或 applyWriteback 的输入输出结构。

## 执行与顺序策略（推荐）

1. **writeback 阶段**  
   - 优先使用 `writebackMany`（若存在），否则按条处理。
   - 允许并行，但需要保证纯函数契约成立。

2. **applyWriteback 阶段**  
   - 严格序列化写入（或按 entity 分区锁），确保一致性。
   - 允许内部批量合并写入。

3. **hooks 阶段**  
   - 写入完成后触发（post-commit）。
   - 如需 pre-commit 事件，明确为只读观察，不允许改变写入。

## 错误与回滚策略

- `transform.writeback` 出错：中止并报错，不产生任何写入副作用。
- `applyWriteback` 出错：可以选择整体失败或局部失败，但必须保证状态一致性。
- hooks 出错：不影响写入结果，必要时捕获并记录。

## 为什么这样设计（收益）

- **可并行与批量**：writeback 纯函数 => 支持并行/批量优化。
- **一致性强**：所有本地状态变更集中在 applyWriteback，降低竞态与隐式依赖。
- **插件更清晰**：hooks 承担副作用，插件作者契约明确。
- **调试与测试更易**：writeback 可单测，applyWriteback 可回放。

## 迁移建议（一步到位）

1. 规定 `transform.writeback` 纯函数契约并写入文档。
2. 所有副作用从 writeback 迁移到 hooks。
3. 本地写入逻辑集中到 `applyWriteback`，禁止绕过。
4. 如有批量需求，引入 `writebackMany` 并在 runtime 优先使用。

## 可执行改动清单（实施步骤）

1. **契约落地**
   - 在文档中明确 `transform.writeback` 纯函数、无副作用、顺序无关。
   - 若需要批量语义，新增 `writebackMany` 接口与优先级规则。

2. **writeback 去副作用**
   - 清理 writeback 内部的事件触发、日志、缓存写入等副作用。
   - 仅保留数据归一化、字段修正、校验与格式化。

3. **状态写入集中**
   - 所有写入都统一进入 `applyWriteback`。
   - 禁止在其他路径直接修改 store / 索引 / 版本号。

4. **hooks 作为唯一副作用入口**
   - 将原 writeback 内的副作用迁移到 hooks。
   - 保证 hooks 失败不会影响写入结果。

5. **执行策略更新**
   - writeback 阶段允许并行或批量（基于纯函数契约）。
   - applyWriteback 阶段序列化或分区锁，确保一致性。

6. **测试策略**
   - 为 writeback 增加纯函数性质测试（同输入同输出、无副作用）。
   - 为 applyWriteback 增加一致性与回放测试。

