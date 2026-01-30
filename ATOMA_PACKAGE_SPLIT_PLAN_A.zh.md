# Atoma 拆包方案 A（推荐版）实施文档

日期：2026-01-30  
状态：草案（可直接按步骤执行）

> 目标：按“稳定边界 + 单向依赖 + 可选能力可选装”拆分为多个 workspace 包，`atoma` 作为聚合包保留现有导入体验。

---

## 1. 目标与非目标

**目标**
- 清晰分层：`shared → protocol → core → client` 的单向依赖。
- 可选能力可选装：`observability/backend/devtools/server` 不污染核心。
- 维持对外导入习惯：继续支持 `atoma/*` 子入口。
- 支持独立发布与版本管理。

**非目标**
- 保持向后兼容（允许破坏式变更）。
- 重新设计 API（本次只拆包，不改业务语义）。

---

## 2. 最终包划分（方案 A）

```
packages/
  atoma/                  # 聚合包（re-export）
  atoma-shared/           # 工具/原语
  atoma-protocol/         # 协议与 ops build/validate
  atoma-observability/    # 观测能力
  atoma-core/             # 本地状态核心
  atoma-client/           # createClient + runtime wiring + plugins/defaults
  atoma-backend/          # ops client + http endpoint 等
  atoma-server/           # 已存在
  atoma-devtools/         # 已存在
  atoma-sync/             # 已存在
  atoma-react/            # 已存在
```

---

## 3. 依赖图（建议保持单向）

```
atoma-shared
  ↑
atoma-protocol        atoma-observability
  ↑         ↑           ↑
  └────┐    └────┐      │
       │         │      │
    atoma-core   │      │
       ↑         │      │
    atoma-client │      │
       ↑         │      │
  atoma-devtools │      │
                 │      │
           atoma-backend│
                 ↑      │
              atoma-server

atoma-sync（独立，可依赖 protocol/core/client 的公开 API）
atoma-react（独立，可依赖 client/core 的公开 API）
```

**边界约束**
- `atoma-core` 不依赖 `backend/server/devtools/sync/react`。
- `atoma-client` 不依赖 `server`。
- `atoma-backend` 仅关心“发 ops”，不依赖 `client` 的内部实现（可依赖公共类型）。

---

## 4. 导入与别名策略

**跨包导入：只用包名**
- `import { Protocol } from 'atoma-protocol'`
- `import { Core } from 'atoma-core'`

**包内导入：仅用包内别名**
- `#shared/*` 仅在 `atoma-shared` 内
- `#protocol/*` 仅在 `atoma-protocol` 内
- `#core/*` 仅在 `atoma-core` 内
- `#client/*` 仅在 `atoma-client` 内

> 避免全局 `#/` 根别名。多包后会冲突且难维护。

---

## 5. 包职责与导出清单（建议）

### 5.1 atoma-shared
- **内容**：工具函数、类型原语、通用错误、稳定 stringify、版本等
- **不依赖**：任何上层包
- **入口**：`src/index.ts`

### 5.2 atoma-protocol
- **内容**：ops 构建/校验、协议类型、序列化规范
- **依赖**：`atoma-shared`
- **入口**：`src/index.ts`

### 5.3 atoma-observability
- **内容**：trace/debug/runtime types
- **依赖**：`atoma-shared`（如有必要）
- **入口**：`src/index.ts`

### 5.4 atoma-core
- **内容**：store/mutation/history/indexes/relations
- **依赖**：`atoma-protocol`、`atoma-shared`、`atoma-observability`（如需）
- **入口**：`src/index.ts`

### 5.5 atoma-client
- **内容**：createClient、runtime wiring、plugins、defaults、drivers
- **依赖**：`atoma-core`、`atoma-protocol`、`atoma-observability`、`atoma-shared`
- **入口**：`src/index.ts` + 子入口（可选）

### 5.6 atoma-backend
- **内容**：ops client（HTTP/批处理）、endpoint 等
- **依赖**：`atoma-protocol`、`atoma-shared`（必要时）
- **入口**：`src/index.ts`

### 5.7 atoma（聚合包）
- **内容**：仅 re-export，保持 `atoma/*` 入口
- **依赖**：所有子包

---

## 6. 实施顺序（建议 6 阶段）

> 每阶段结束建议跑 `pnpm typecheck` 与关键测试；确保依赖图无环。

### Phase 0：准备与基线
1. 记录当前入口与依赖：
   - `packages/atoma/package.json` 的 `exports` 与 `imports`
   - `packages/atoma/tsup.config.ts` 的入口
2. 冻结目录与命名：本方案所有新包命名固定为 `atoma-*`。

### Phase 1：拆 `shared`
1. 新建 `packages/atoma-shared/`（`package.json`、`tsup.config.ts`、`tsconfig.json`、`src/index.ts`）。
2. 移动 `packages/atoma/src/shared/**` → `packages/atoma-shared/src/**`。
3. 修正导入路径：
   - 跨包改为 `from 'atoma-shared'`
   - 包内改为 `#shared/*`

### Phase 2：拆 `protocol`
1. 新建 `packages/atoma-protocol/` 基础脚手架。
2. 移动 `packages/atoma/src/protocol/**` → `packages/atoma-protocol/src/**`。
3. 修正导入：
   - 其他包 `from 'atoma-protocol'`
   - 包内 `#protocol/*`

### Phase 3：拆 `observability`
1. 新建 `packages/atoma-observability/` 脚手架。
2. 移动 `packages/atoma/src/observability/**` → `packages/atoma-observability/src/**`。
3. 修正导入。

### Phase 4：拆 `core`
1. 新建 `packages/atoma-core/` 脚手架。
2. 移动 `packages/atoma/src/core/**` → `packages/atoma-core/src/**`。
3. 修正导入：
   - 对外 `from 'atoma-core'`
   - 包内 `#core/*`

### Phase 5：拆 `client`
1. 新建 `packages/atoma-client/` 脚手架。
2. 移动 `packages/atoma/src/client/**`、`plugins/**`、`runtime/**`、`drivers/**`、`defaults/**` → `packages/atoma-client/src/**`。
3. 修正导入：
   - `#client/*` 仅包内
   - 对外 `from 'atoma-client'`
4. 将 `backend` 仍留在独立包（Phase 6 处理）。

### Phase 6：拆 `backend`
1. 新建/或合并到 `packages/atoma-backend/`。
2. 移动 `packages/atoma/src/backend/**` → `packages/atoma-backend/src/**`。
3. 修正导入：
   - 对外 `from 'atoma-backend'`
   - 包内 `#backend/*`（仅在 `atoma-backend` 内使用）

---

## 7. 聚合包 `atoma` 的定位与结构

`atoma` 只做 re-export 与子入口整合：

```
atoma/
  src/index.ts                # 导出 Core/Protocol/Observability 等
  src/core/index.ts           # re-export from atoma-core
  src/protocol/index.ts       # re-export from atoma-protocol
  src/shared/index.ts         # re-export from atoma-shared
  src/observability/index.ts  # re-export from atoma-observability
  src/client/index.ts         # re-export from atoma-client
  src/backend/index.ts        # re-export from atoma-backend
```

**exports 建议**
- 保留 `atoma/*` 入口：`./core`、`./protocol`、`./shared`、`./observability`、`./client`、`./backend`
- `.` 默认只导出最小核心或常用门面

---

## 8. 构建与配置建议

**每个包应包含**
- `package.json`：`name`、`version`、`exports`、`types`、`sideEffects`
- `tsup.config.ts`：只打自己包入口
- `tsconfig.json`：引用根 `tsconfig.base.json`
- `src/index.ts`：公开 API

**workspace 依赖**
- 在各包 `package.json` 使用 `workspace:*` 对内部包依赖。

---

## 9. 迁移注意点（高频坑）

1. **import alias 冲突**
   - `#core/#protocol/#shared` 必须变成“包内 alias”，跨包只用包名。

2. **循环依赖**
   - `client` 不要反向依赖 `backend` 的内部实现。
   - `backend` 不要依赖 `client`（除非仅依赖公共类型且不引入内部实现）。

3. **类型导出**
   - 入口文件需明确 re-export 类型，否则 TS d.ts 会断链。

4. **tsup 入口与路径**
   - 每个包只打自己的入口，不要再打其他包的子入口。

---

## 10. 验收清单

**必做检查**
- `pnpm typecheck`
- `pnpm test`
- 关键包可被单独构建：`pnpm -C packages/atoma-core build`（同理其他包）
- `atoma/*` 入口可正常导入并通过类型检查

**验证场景**
- `atoma-react` 正常编译（依赖 core/client）
- `atoma-backend-*` 正常编译（依赖 backend/protocol）
- `atoma-server` 正常编译（依赖 backend/protocol/shared）

---

## 11. 迁移后建议的文档更新

- README 与 README.zh 中说明新的包分层。
- 对外示例同时给出两种导入方式：
  - 直接包名：`atoma-core` / `atoma-client`
  - 聚合入口：`atoma/core` / `atoma/client`

---

## 12. 如果要进一步压缩风险（可选）

- 先只拆 `shared/protocol/observability` 三个底层包；
- 然后拆 `core`；
- 最后拆 `client/backend`（最容易牵扯外部包）。

---

如需我继续把该方案落实成具体的“文件移动清单 + 导入替换清单 + 每包脚手架模板”，告诉我你想先从哪个 Phase 开始。  
