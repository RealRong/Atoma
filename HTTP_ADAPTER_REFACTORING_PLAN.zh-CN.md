# HTTPAdapter 重构方案（委托式固定管线）

本文定义 `HTTPAdapter` 的目标架构：**它是 Atoma 内部的权威 HTTP 适配器实现**，而不是一个“用户可随意插拔中间件的平台”。用户最多通过少量受控 hooks 参与观测与轻量改写（如附加 headers / 记录日志），核心管线顺序与语义由库内部固定并保证一致。

前提：库尚未对外广泛使用，允许破坏性变更，优先级以“优雅、可读、一致性、可维护”高于“向后兼容”。

---

## 1. 设计目标与非目标

### 目标
- **职责分离**：Batch / Sync / REST / Transport / Store 回写各司其职。
- **状态归属清晰**：队列、定时器、订阅连接、ETag/version 缓存等状态只属于一个组件。
- **生命周期清晰**：组件自持资源并实现 `dispose()`，由 `HTTPAdapter` 级联释放。
- **固定且可推理的请求流**：同一类请求永远走同一条路径；短路规则明确。
- **前后端协议一致**：REST 统一走 `Protocol.http.*`（parse/compose），降低字段漂移带来的复杂度。

### 非目标
- 不提供“用户自定义中间件顺序/短路”的通用平台。
- 不为了通用 REST 而污染 Atoma 主路径（如需兼容其他后端，应该做独立 adapter/compat 层）。

---

## 2. 固定管线（从 IAdapter 调用到本地状态更新）

核心心智模型：

1) **请求进入**：用户调用 `IAdapter` 方法（get/findMany/create/update/delete/patch 等）
2) **标准化**：转成内部 `Operation`（携带 `signal/internalContext` 等）
3) **路由选择**：根据配置与操作类型选择管线
    - Query → REST 或 BatchQuery
    - Write → REST 写入或 Sync/Offline 写入（乐观/队列）
4) **请求组装与发送**：统一走 `transport`（headers/trace/retry/events + fetch）
5) **协议解析**：REST 统一 `Protocol.http.parse.envelope`，Batch/Sync 走各自协议
6) **本地回写**：交给 `StateWriter`（唯一允许写 store 的入口）
7) **返回结果**：将语义化结果映射回 `IAdapter` 返回值

> 重要约束：除 `StateWriter` 外，任何组件都不直接 `applyPatches/commitAtomMapUpdate`，它们只能产出“回写指令/事件”。

---

## 3. 组件划分（委托式，而非洋葱式）

建议把 `HTTPAdapter` 视为“组合根 + 门面”，把真实状态与逻辑分散到可命名的子系统中。

### 3.1 `HTTPAdapter`（门面 / 组合根）
- 只做：
  - 规范化配置（endpoints 推导、默认值）
  - 构造子系统并注入依赖
  - 实现 `IAdapter` 方法：**直接委托**给各子系统
  - `dispose()`：级联释放
- 不做：
  - 不维护 sync/batch 的内部状态
  - 不做协议解析细节
  - 不做 store 回写细节

### 3.2 `RestEngine`（REST 读写编排）
- 负责：把读/写操作映射为 REST 请求，调用 transport，并把响应解析成稳定语义
- 依赖：
  - `transport`（发送/重试/headers/trace/events）
  - `Protocol.http.parse.envelope`
- 状态：尽量无状态（若有缓存/并发控制，也必须明确归属）

### 3.3 `BatchEngine`（批处理效率层）
- 负责：query 的缓冲、合并、flush、拆包分发
- 状态：buffer、flush 定时器、in-flight 映射
- 依赖：batch 协议与 mapResults（`#protocol` batch result mapping）

### 3.4 `SyncEngine`（一致性与离线）
- 负责：
  - offline queue 管理（入队/出队/重放）
  - push/pull 的编排
  - subscribe（SSE/EventSource）的连接管理与重连策略
- 状态：队列、cursor、网络状态、订阅句柄、后台任务
- 依赖：
  - `transport/raw`（用于 sync pull/push 的“raw json request”边界）
  - sync 协议（`#protocol`）

### 3.5 `WriteClient`（写入语义：ETag/version/冲突）
- 负责：写入路径的底层语义（版本、条件请求、冲突处理策略）
- 状态：例如 ETag 缓存（如果存在）
- 依赖：transport、conflict resolver、version config

### 3.6 `StateWriter`（本地回写）
- 负责：把“网络语义结果”转换为对 store 的唯一写入动作
- 典型输入：
  - REST ok(data/pageInfo/meta) / error
  - Batch mapResults 输出
  - Sync push ack/reject、sync changes
- 典型输出：
  - 本地 store patch/commit
  - devtools/observability 事件

---

## 4. Hooks 设计（受控扩展，而非可编程管线）

目标：允许用户做“观测与轻量改写”，但不允许破坏核心语义与可推理性。

### 建议提供的 hooks（示意）
- `onRequest(req)`：请求已标准化、即将发送（可追加 headers、记录日志、采样埋点）
- `onResponse(res)`：响应已解析成 envelope/语义结果（可统计、记录、打点）
- `onError(err, context)`：统一错误出口（观测/上报）

### 建议的能力边界
- 允许：追加 headers、附加 trace/meta、记录日志、统计耗时与 payload 大小
- 不鼓励/避免：改写 body 的业务语义、吞错、改变重试/批处理/离线策略、改变协议解析结果

> 实现上 hooks 最适合挂在 `transport` 边界：请求发出前与响应解析后，避免侵入 batch/sync 的内部状态机。

---

## 5. 目录结构（与当前代码对齐的演进方向）

当前对外稳定入口：
- `src/adapters/HTTPAdapter.ts`：facade（稳定导出）

建议保持的内部边界（现有为主）：
- `src/adapters/http/adapter/*`：组合根与门面实现（后续可进一步拆成 engines）
- `src/adapters/http/transport/*`：headers/trace/events/retry/pipeline/raw
- `src/adapters/http/config/*`：HTTPAdapter 配置与类型
- `src/protocol/http/*`：REST 标准 envelope、parse、compose（client/server 共用）

进一步削薄的方向（可选，按优雅度继续推进）：
- `src/adapters/http/engines/rest/*`
- `src/adapters/http/engines/batch/*`
- `src/adapters/http/engines/sync/*`
- `src/adapters/http/state/*`（StateWriter）

---

## 6. 落地顺序（保持可验证、可回滚）

1) **先切“状态归属”**：把 sync/batch 的状态字段从 `HTTPAdapter` 移出到 `SyncEngine/BatchEngine`
2) **再切“回写入口”**：集中本地写入到 `StateWriter`
3) **最后切“请求编排”**：让 `HTTPAdapter` 的每个 `IAdapter` 方法只做路由与委托

验证：
- `npm run typecheck`
- `npm test`

---

## 7. 结论

对 Atoma 来说，“委托式固定管线 + 少量受控 hooks”比“通用洋葱式中间件平台”更优雅、更可推理，也更符合“协议强绑定、前后端一致、减少复杂度”的长期方向。
