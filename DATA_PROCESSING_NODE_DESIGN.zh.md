# DataProcessor 设计文档（统一校验与转换）

## 背景与问题
当前 `validateWithSchema` 与 `transformData` 分散在多个入口与流程节点中（store ops、writeback、backend adapter 等），存在如下问题：
- 数据进入/写回的处理路径不统一，重复逻辑难以复用
- 处理顺序不明确（先校验还是先转换），引发隐性行为差异
- 错误语义与观测点分散，难以定位与诊断
- 难以扩展（迁移、标准化、敏感字段过滤等功能难以集中落地）

## 目标
- 将 `validateWithSchema` 与 `transformData` 收敛到**单一数据处理节点**
- 明确数据处理的**阶段顺序**、**错误语义**、**可观测性**
- 形成**可扩展的管线能力**，覆盖常见数据处理需求
- 减少重复逻辑、降低维护成本，提升一致性
- 移除旧 API 与分散调用，**一步到位**切换到新架构

## 非目标
- 不改变现有业务语义（除非明确列出）
- 不引入兼容层或中间层（直接重构到统一节点）
- 不更换现有 schema/validator 实现

## 统一数据处理节点设计
统一节点命名为 `DataProcessor`，作为 **所有数据进入/写回/读取** 的唯一入口。核心职责：
1. 统一处理阶段
2. 统一错误语义
3. 统一观测与性能控制

### 处理阶段（行业规范对齐）
固定顺序如下（顺序不可变，阶段按配置启用）：
1. **deserialize**（解析/反序列化）：外部输入转为内部对象结构
2. **normalize**（标准化/迁移）：字段裁剪、别名映射、版本迁移、默认值补齐
3. **transform**（转换/派生）：应用 `transformData` 或同类逻辑（派生字段、格式化）
4. **validate**（校验）：使用 `validateWithSchema` 或等价 validator 进行结构与约束验证
5. **sanitize**（安全过滤）：敏感字段剔除、只读字段保护
6. **serialize**（序列化/输出）：写回或返回前的收尾处理

说明：上述顺序符合“先 normalize/transform，再 validate”的行业惯例，避免校验基于未标准化数据导致的误报或重复转换。

### 行业规范对齐点
- **单一入口、分层职责**：数据处理集中且职责清晰
- **确定性与幂等性**：同输入得到同输出，便于回放与重试
- **可观测性**：统一打点、日志与错误类型
- **版本迁移可治理**：显式迁移阶段，便于迭代
- **安全性**：敏感字段过滤与只读保护内置

## 统一节点的能力范围
统一纳入以下“同类功能”：
- 数据标准化/清洗：trim、去空、去冗余字段
- 字段映射与兼容：旧字段映射新字段
- 版本迁移：schema 版本升级/迁移
- 业务规则校验：跨字段约束
- 派生字段计算：derived/denormalized
- 安全过滤：敏感字段剔除、只读字段保护
- 序列化/反序列化：持久化与传输边界处理

## 与当前系统的结合方式
### 统一节点放置位置
放在 core 内部（例如 `src/core/store/internals` 或 `src/core/pipeline`），并作为 store write/read 的唯一入口。

### 数据流入口
- **本地写入**：所有 store ops 写入前统一经过 `DataProcessor`
- **远端同步回填**：写回/merge 前统一处理
- **后端适配器**：读写端统一通过同一节点

## 受影响代码范围（需调整）
下列路径当前直接调用 `validateWithSchema`/`transformData`，需迁移至统一节点：
- `src/core/store/ops/updateMany.ts`
- `src/core/store/ops/upsertMany.ts`
- `src/core/store/ops/deleteMany.ts`
- `src/core/store/ops/upsertOne.ts`
- `src/core/store/ops/updateOne.ts`
- `src/core/store/internals/writePipeline.ts`
- `src/core/store/internals/writeback.ts`
- `src/core/store/internals/runtime.ts`（transformData 注入点）
- `src/core/createStore.ts`
- `src/core/types.ts`（类型字段与配置项）
- `src/core/mutation/pipeline/LocalPlan.ts`（transformData 传递）
- `src/client/types/backend.ts`
- `src/client/types/schema.ts`
- `src/backend/ops/local/IndexedDBOpsClient.ts`
- `src/core/store/internals/validation.ts`

## 旧 API 清理与迁移策略（一步到位）
本次改造**删除旧 API 和分散调用**，不保留兼容层，原因：当前无外部用户依赖。
- 删除 `validateWithSchema` 的直接调用路径
- 删除 `transformData` 在各处的直接调用路径
- 所有读写入口统一改为 `DataProcessor.process`
- 旧 API 仅保留作为内部实现细节（如仍需要，可内联到 DataProcessor 内部），不对外暴露

## 设计与实现方式（不引入兼容层）
### 1) 统一命名与接口
统一节点命名为 `DataProcessor`，以下为唯一命名规范（对内 API）：
- `DataProcessor`：唯一处理入口
- `DataProcessorMode`：`'inbound' | 'writeback' | 'outbound'`
- `DataProcessorStage`：`'deserialize' | 'normalize' | 'transform' | 'validate' | 'sanitize' | 'serialize'`
- `DataProcessorContext`：运行时上下文（store/runtime、schema、adapter 等）
- `process(mode, data, context)`：唯一执行入口
- `normalize`、`transform`、`validate`、`sanitize`、`serialize`：阶段函数名
- `deserialize`：输入边界解析函数名

### 2) 阶段配置
阶段配置固定放在 **每个 store config 的 `dataProcessor` 子属性** 下，字段命名固定：
- `dataProcessor.deserialize`
- `dataProcessor.normalize`
- `dataProcessor.transform`
- `dataProcessor.validate`
- `dataProcessor.sanitize`
- `dataProcessor.serialize`

### 2.1) createClient 全局配置
`createClient` 接受全局 `dataProcessor` 配置，用于统一默认行为，命名固定：
- `createClientConfig.dataProcessor`

合并规则固定为：
- `storeConfig.dataProcessor` 覆盖 `createClientConfig.dataProcessor`
- 未配置阶段视为 identity（空操作）
- runtime 只执行，不持有默认配置

### 3) 统一调用入口
将所有 `validateWithSchema` 与 `transformData` 调用点迁移到 `DataProcessor.process`：
- ops 写入路径：改为调用节点一次
- writeback/merge：改为调用节点一次
- backend adapter：读写均通过节点

### 4) 错误语义与观测统一
- 统一错误类型与 error code（如 `ValidationError`、`TransformError`）
- 将阶段信息写入 error metadata（便于诊断）
- 统一 metrics/log 入口（如 “validation.count” 等）

### 5) 配置与扩展
通过 **store config 的 `dataProcessor`** 统一承载扩展点，命名固定为：
- `dataProcessor.deserialize`
- `dataProcessor.normalize`
- `dataProcessor.transform`
- `dataProcessor.validate`
- `dataProcessor.sanitize`
- `dataProcessor.serialize`

### 6) 校验顺序落地
明确流程顺序并固化在节点实现中，避免多处重复判断。

## 验收标准
- 所有写入/写回/同步路径只调用**一次**统一节点
- 不再在 ops 或 adapter 中直接调用 `validateWithSchema` 或 `transformData`
- 文档与类型对齐统一入口、统一顺序
- 通过现有测试（或新增覆盖处理顺序的测试）

## 风险与缓解
- **顺序变更风险**：通过阶段开关与回归测试控制
- **性能影响**：通过合并处理与避免重复校验降低成本
- **行为差异**：在迁移阶段对比输出与校验结果

## 实施步骤（阶段内完成，一步到位）
1. 定义统一节点接口与默认阶段顺序
2. 迁移所有调用点到节点入口
3. 删除分散调用并清理类型/配置冗余
4. 补齐测试与文档

---
该方案以单节点统一处理作为“行业规范式”的数据管线实践，适合当前 store/core 的集中治理与后续扩展。
