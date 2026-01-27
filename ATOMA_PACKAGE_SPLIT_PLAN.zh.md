# Atoma 拆包规划（从 `packages/atoma` 继续拆分）

本文档目标：在已经把主源码迁移到 `packages/atoma/src/**` 的基础上，设计下一步如何继续拆成多个 workspace 包（位于 `packages/*`），以降低耦合、减少可选能力对核心的污染，并让每个包都能拥有自己包内的别名/工具链配置。

约束/假设
- 允许破坏式变更（无用户、无需兼容层）。
- 目标优先级：架构清晰 > 代码简单 > 工程稳定（CI/构建/测试）> 发布兼容。
- `atoma-sync`、`atoma-react` 已经是独立包。

---

## 1. 当前结构（已完成）

当前 `packages/atoma/src` 仍然是一个“多模块单包”：

```
packages/atoma/src/
  core/
  protocol/
  shared/
  observability/
  client/
  backend/
  index.ts
```

补充（已落地）：
- `server` 已从 `packages/atoma/src/server` 拆到独立包 `packages/atoma-server`。
- `devtools` 已从 `packages/atoma/src/devtools` 拆到独立包 `packages/atoma-devtools`（含 Inspector + Shadow DOM UI）。

这意味着：
- 任何对 `atoma` 的依赖都会“潜在”把 backend/server 等重模块带进来（即使通过 tree-shaking 规避，心智负担仍在）。
- 包内 `#core/#protocol/#shared/...` 别名在单包内很好用，但一旦多包化就会出现冲突/语义不清的问题（尤其当多个包都想要自己的“根别名”）。

---

## 2. 拆包原则（哪些模块“应该”拆出去）

拆包的核心不是“目录多”，而是**边界稳定 + 依赖单向 + 可选能力可选装**。

建议按以下标准判断是否需要成为独立包：

必须拆（高收益）
- **backend**：网络/HTTP/批处理重逻辑，和核心 store 不是同一层；未来还可能引入更多传输/重试/遥测依赖。
- **server**：服务端适配必然引入更多生态依赖（hono/express/typeorm/prisma 等），应该与核心完全隔离。
- **devtools（运行时 inspector）**：仅开发/调试用途，应该可选装，且不影响 core/client 的复杂度与依赖图。

建议拆（中高收益，边界天然）
- **protocol**：协议类型 + ops build/parse/transport 辅助，属于“跨端契约层”，被 core/client/backend/server/sync 多方使用，单独包能明显减少循环依赖风险。
- **observability**：跨层能力（trace/debug），很多情况下是可选的；独立包能避免 core/client/backend/server 相互缠绕。

可拆可不拆（低收益，除非你要极致最小核心）
- **shared**：工具/原语集合。它通常会成为“最底层包”；拆出去收益在于依赖图更清晰、避免把 shared 当成杂物堆。若你准备全面多包化，建议也拆。

通常不建议单独拆（除非你要发布成非常细的微包）
- core 内部子模块（indexes/history/mutation 等）：这些更适合通过目录/内部接口治理，而不是拆成多个 npm 包。

---

## 3. 推荐目标架构（workspace 多包）

### 3.1 推荐包划分（最终形态）

```
packages/
  atoma/                  # 可选：聚合包（见 3.3）
  atoma-shared/           # 最底层：纯工具/原语（zod、url、errors、stableStringify、version...）
  atoma-protocol/         # 协议与传输工具（ops build/validate/sse/http）
  atoma-observability/    # trace/debug/sampling/runtime types
  atoma-core/             # 本地状态核心（store/mutation/history/indexes/relations）
  atoma-client/           # createClient + runtime wiring（依赖 core/protocol/observability）
  atoma-backend/          # ops client（http/local/batch），只处理“如何发 op”，不包含 server
  atoma-server/           # server handlers + adapters（typeorm/prisma/hono 等）
  atoma-devtools/         # inspector（运行时观测/诊断能力），可选装
  atoma-sync/             # 已存在：sync engine/outbox/lanes/transport
  atoma-react/            # 已存在：React bindings
```

### 3.2 依赖图（建议保持严格单向）

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

atoma-sync（独立，可依赖 protocol/core/client 的“公开 API”）
atoma-react（独立，可依赖 client/core 的“公开 API”）
```

边界说明（关键点）
- `atoma-core` 不应该依赖 `backend/server/devtools/sync/react`。
- `atoma-client` 可以依赖 `atoma-sync`（可选）；但 `atoma-sync` 也不应依赖 `atoma-client`（避免环）。
- `atoma-server` 只能依赖 `atoma-backend/protocol/shared`（以及 server 生态依赖），避免依赖 client/react。

---

## 4. 导入/别名策略（避免未来多包别名冲突）

### 4.1 核心结论

如果未来每个包都想要“包内别名”，就不应该使用类似 `#/...` 这种“全局唯一根别名”。

推荐规则（最简单、最符合 Node/TS 工具链现实）：

1) **跨包导入：只用包名**
   - 例：`import { Shared } from 'atoma-shared'`
   - 例：`import { Protocol } from 'atoma-protocol'`

2) **包内导入：用包前缀别名（仅限包内部）**
   - 例：在 `atoma-sync` 内：`#sync/*`
   - 例：在 `atoma-core` 内：`#core/*`
   - 例：在 `atoma-client` 内：`#client/*`

这样做的原因：
- Node 的 `package.json#imports`（`#xxx`）本质是“包内 import map”，天然是包级作用域，最适合表达“包内别名”。
- TypeScript/Vite/Vitest 的 alias 通常是“全局 resolver”，`#/` 这类根别名在多包时必然冲突。

### 4.2 是否保留 `#shared` / `#protocol` 这种别名？

建议：
- **包内可以保留**（例如 `atoma-protocol` 包内使用 `#protocol/*`），但**跨包不要用**。
- 如果你坚持跨包也用 `#shared`：那么必须依赖构建器在产物里做 rewrite（复杂度显著上升），不符合“代码简单”的目标。

---

## 5. 拆分实施顺序（破坏式、一次到位但分阶段落地）

下面给出一个“风险从低到高”的顺序。每一阶段结束都应保证：
- `npm run typecheck`、`npm test`、`npm run build` 通过
- 依赖图不出现环

### Phase 1：先拆 `backend` / `server`（最大幅度降低核心复杂度）
目标：
- `atoma-backend`、`atoma-server` 成为独立包
- `packages/atoma`（或未来 `atoma-core/client`）不再承载 server 生态依赖

动作（概念）：
- 移动目录：
  - `packages/atoma/src/backend/**` → `packages/atoma-backend/src/**`
  - `packages/atoma/src/server/**` → `packages/atoma-server/src/**`
- 在 `atoma-server` 中把 typeorm/prisma 相关保持为 optional peer（或拆成 `atoma-server-adapter-typeorm` 等更细粒度包）。

### Phase 2：拆 `protocol`
目标：
- `protocol` 成为跨端契约层，供 core/client/backend/server/sync 使用

动作（概念）：
- `packages/atoma/src/protocol/**` → `packages/atoma-protocol/src/**`
- `atoma-protocol` 只依赖 `atoma-shared`（如果 shared 已拆）或直接无依赖。

### Phase 3：拆 `shared`
目标：
- shared 变成最底层包，避免“工具箱膨胀”污染核心

动作（概念）：
- `packages/atoma/src/shared/**` → `packages/atoma-shared/src/**`
- 明确 shared 不能依赖 protocol/core/client/backend/server（禁止反向依赖）。

### Phase 4：拆 `observability`
目标：
- observability 变成可选能力（至少在依赖图上可选）

动作（概念）：
- `packages/atoma/src/observability/**` → `packages/atoma-observability/src/**`
- `atoma-core/client/backend/server` 只依赖其 types + runtime（必要时提供 no-op fallback）。

### Phase 5：拆 `core` / `client`（最终让 “atoma = 本地状态库核心”）
目标：
- `atoma-core`：只保留 store 核心能力
- `atoma-client`：只保留 createClient / runtime wiring（含 sync wiring，但 sync 逻辑仍在 atoma-sync）

动作（概念）：
- `packages/atoma/src/core/**` → `packages/atoma-core/src/**`
- `packages/atoma/src/client/**` → `packages/atoma-client/src/**`

### Phase 6：拆 `devtools`（运行时 inspector）
目标：
- 不影响生产依赖图；只在开发时安装/启用

动作（概念）：
- `packages/atoma/src/devtools/**` → `packages/atoma-devtools/src/**`

---

## 6. `packages/atoma` 的最终定位（两种可选策略）

### 策略 A（推荐）：`atoma` 作为“聚合包/门面”
- `atoma` 只做 re-export，保持外部 import 习惯（例如 `atoma/core`、`atoma/protocol`）。
- 好处：外部 API 更像 “slate + slate-react” 的生态。
- 代价：需要维护 re-export 入口与构建（但实现上很薄）。

### 策略 B：移除聚合包，只保留多包
- 用户直接 `import { ... } from 'atoma-core'`、`'atoma-client'`…
- 好处：最简单直接，包边界最清晰。
- 代价：外部 import 形态变化大；你仓库内部现有 `atoma/*` / `#core` 风格需要大规模调整。

在你当前“无用户、一次破坏式变更”的前提下，两者都可行：
- 如果你重视未来生态一致性：选 A。
- 如果你只想要最少工程复杂度：选 B。

---

## 7. 额外注意点（避免踩坑）

1) 构建顺序与 workspace 依赖
- 一旦拆成多包，构建需要按依赖图顺序；建议引入任务编排（npm workspaces 也能做，但更推荐后续用 turbo/nx）。

2) 类型与运行时路径的一致性
- TS `paths` 只能解决开发态；发布态必须确保产物里没有残留 `#xxx` 指向其他包的别名（建议跨包用包名）。

3) 可选依赖隔离
- `typeorm/@prisma/client` 只应出现在 server 相关包（或更细的 adapter 包），不要出现在 core/client/protocol/shared。

4) sync 依赖边界
- `atoma-sync` 应该只依赖 `atoma-protocol`（transport/ops builder）+（可选）`atoma-core`（如果需要 core 的某些公开类型）。
- 避免 `atoma-sync` 依赖 `atoma-client`（否则 client 又依赖 sync 会形成环）。
