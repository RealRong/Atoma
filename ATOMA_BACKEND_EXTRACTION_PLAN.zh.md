# 抽离 Backend 为独立包（workspace 多包：atoma-backend）方案

本文档描述：在同一仓库的 workspace（monorepo）内，把当前 `src/backend/**` 抽离成独立包 `atoma-backend`，让 `atoma` 核心更聚焦“本地状态库（core/store/history/indexes/protocol）”，backend 成为可选能力层。

约束与原则：
- 允许破坏式变更（不做兼容层/过渡命名）。
- workspace 内多包优先（降低拆包成本，类型共享最顺滑）。
- `atoma`（核心）不依赖 `atoma-backend`；依赖方向单向，避免循环依赖。

---

## 1. 为什么 backend 适合独立成包

backend（HTTP/IndexedDB/Memory/SQLite 等）本质是“适配器/运行时实现”，它带来的复杂度与核心本地状态库不同：
- 环境差异：browser/node/react-native/edge 对 fetch、EventSource、IndexedDB 支持不同
- 依赖膨胀：HTTP 重试/拦截器、IndexedDB 封装、SQLite 驱动往往引入额外依赖
- 测试成本：需要 mock 网络/IDB/存储环境，干扰 core 的单测纯度

拆成 `atoma-backend` 后，收益是：核心包更纯、依赖树更干净、按需安装更灵活。

---

## 2. 抽离目标：包边界与依赖方向

### 2.1 `packages/atoma`（核心包）负责
- `core/`：store、mutation、history、indexes、runtime types
- `protocol/`：协议 types + parse/validate（协议属于底座）
- **只保留最小接口**（供 backend 实现使用）：
  - `OpsClientLike`（或 `OpsClient` 接口）
  - （可选）错误类型、共享工具（例如 `Shared.url`）

关键要求：`atoma` 不 import `atoma-backend`（避免 core 被实现层污染）。

### 2.2 `packages/atoma-backend`（实现包）负责
- `HttpOpsClient`、`IndexedDBOpsClient`、`MemoryOpsClient`、（可选）SQLite ops client
- 任何与具体运行环境有关的实现细节与依赖
-（可选）提供“backend 解析/装配”的 helper，但要避免把 client wiring 一起塞进来

依赖方向建议：
- `atoma-backend` → `atoma`（复用 `Protocol`、ops types、最小接口）
- **禁止** `atoma` → `atoma-backend`

> 如果未来想进一步纯化：可以再抽一个 `atoma-protocol`，让 `atoma` 与 `atoma-backend` 都依赖它。但这是“第二阶段”，workspace 内先不必做。

---

## 3. 推荐的 workspace 多包结构

推荐一次到位（最清晰的边界）：
```
packages/
  atoma/                 # 核心：core + protocol + client(可选，见后文)
    package.json
    src/...
  atoma-backend/         # 实现：HTTP/IDB/Memory/SQLite
    package.json
    src/...
```

如果你希望把“client（createClient 等）”也变成可选层（强烈推荐，避免 client 反向拉回 backend 依赖），可以扩展为：
```
packages/
  atoma/                 # 纯核心
  atoma-backend/         # 适配器实现
  atoma-client/          # createClient + wiring（依赖 atoma + atoma-backend + atoma-sync）
  atoma-sync/            # sync 引擎（可选）
```

但本文档聚焦 `atoma-backend` 抽离；`atoma-client/atoma-sync` 可在后续文档推进。

---

## 4. `atoma-backend` 的 public API 设计（尽量小）

建议仅导出实现类与最少类型，不导出内部细节：
- `Backend.Ops.HttpOpsClient`
- `Backend.Ops.IndexedDBOpsClient`
- `Backend.Ops.MemoryOpsClient`
-（可选）`Backend.Ops.SqliteOpsClient`

并保持与当前代码风格一致的命名空间导出：
- `export const Backend = { Ops: { ... } } as const`

这样 client/core 的引用稳定，减少“到处散落 import 路径”的噪声。

---

## 5. 抽离步骤（workspace 内、破坏式、一次到位）

### Phase 1：建立 workspace 与包骨架（不改行为）
1) 根 `package.json` 开启 workspaces：
   - `"workspaces": ["packages/*"]`
2) 创建 `packages/atoma-backend/package.json`：
   - `name: "atoma-backend"`
   - `main/module/types` 与构建脚本（可复用现有 tsup/tsconfig）
   - `dependencies`：`"atoma": "workspace:*"`（用于复用 Protocol/types）
3) 把 `src/backend/**` 搬到 `packages/atoma-backend/src/**`
4) `packages/atoma-backend/src/index.ts` 导出 `Backend` 命名空间

### Phase 2：主包中移除 backend 代码路径（切断实现层）
1) `atoma` 中删除（或不再编译进主包）原 `src/backend/**`
2) 所有 `#backend` 路径别名改为指向 `atoma-backend` 包入口（或在 workspace 内映射到 `packages/atoma-backend/src/index.ts`）
3) 确保 `atoma` 本身没有任何 import `#backend` 的地方（若有，说明 core 仍耦合实现层，需要继续解耦）

### Phase 3：把“backend 装配/解析”从 core 彻底挪走
你现在有类似 `resolveBackend` 的逻辑（在 client internal）。拆包后建议：
- `atoma-backend` 只提供“实现类”
- `atoma-client`（或 `atoma` 的 client 子模块）负责把用户配置解析成 `ResolvedBackend`

这样 `atoma-backend` 不需要知道 client 的概念（避免反向耦合）。

### Phase 4：按环境拆可选子包（可选，但长期更优）
当你引入 SQLite 等依赖时，建议进一步拆分：
- `atoma-backend-http`
- `atoma-backend-indexeddb`
- `atoma-backend-sqlite`
- `atoma-backend-memory`

避免把所有环境依赖强行装进一个包，降低安装成本与打包冲突。

---

## 6. client 如何安装与接入（workspace 内）

在 workspace 场景下，client 侧接入非常简单：
- 在 `packages/atoma-client/package.json`（或当前根包）里依赖：
  - `"atoma-backend": "workspace:*"`
- 代码里使用：
  - `import { Backend } from 'atoma-backend'`
  - 或继续使用内部路径别名（推荐最终统一走 npm 包导入，减少 tsconfig path 魔法）

如果你仍希望保留 `#backend` 别名（仅内部用）：
- 让 `tsconfig.paths` 的 `#backend` 指向 `packages/atoma-backend/src/index.ts`
- bundler（tsup/vite/vitest）同步该 alias

---

## 7. 可引入的开源库：优先替代样板、保持代码简单

backend 最值得“交给库”的点是：HTTP 客户端封装、IndexedDB 操作封装、重试/超时/取消等可靠性机制。

### 7.1 HTTP（建议二选一）
- `ky`：
  - 优点：基于 fetch、拦截器/重试体验好、代码可读性高
  - 适合：浏览器/现代运行时
- `ofetch`：
  - 优点：更轻，默认 JSON 处理友好，适合通用 fetch 封装

如果你需要 node 环境更强一致性：
- 统一使用 node18+ 原生 fetch（或显式引入 `undici`），但尽量把差异封装在 `HttpOpsClient` 内部。

### 7.2 IndexedDB（强烈推荐）
- `idb`：
  - 能显著减少 transaction/cursor/upgrade 的样板
  - 让 `IndexedDBOpsClient` 代码更短、更不容易写错

### 7.3 SQLite（如果要支持）
SQLite 依赖通常很重、平台差异大，强烈建议独立子包：
- node：`better-sqlite3`（同步、性能强；但原生编译依赖重）
- react-native：`react-native-quick-sqlite` 或 expo 相关方案

结论：SQLite 不建议塞进统一 `atoma-backend`，应做 `atoma-backend-sqlite`。

### 7.4 重试/超时（与 sync 类似，推荐在 backend 内统一）
- `p-retry`：把“某一次 http 请求”包一层 retry，读起来非常直观
-（更工程化）`cockatiel`：retry + timeout + circuit breaker 一套可靠性组合

### 7.5 schema/配置校验（你已决定 zod v4）
- `zod v4`：继续用于 backend config parse/normalize
- 把校验收敛在 client/build 阶段（构造时不再重复校验）更符合你当前的架构方向

---

## 8. 风险点与规避

- 循环依赖：务必保证 `atoma` 不依赖 `atoma-backend`。若 `createClient` 仍在 atoma 内且引用 backend 实现，建议把 `createClient` 抽到 `atoma-client`。
- 类型重复：优先让 `atoma-backend` 依赖 `atoma` 来复用 `Protocol` 与 ops types；不要复制定义，避免漂移。
- 打包体积：IndexedDB/SQLite/Polyfill 不要无脑进主包。拆子包或 peerDependencies。

---

## 9. 最终结论

在 workspace 多包前提下，抽离 `atoma-backend` 的收益（核心更纯、依赖隔离、可选安装、环境差异收敛）明显大于成本（多包构建/发布、边界整理）。建议以 “`atoma` 纯核心 + `atoma-backend` 实现层 +（可选）`atoma-client/atoma-sync`” 的结构一步到位，这会让你后续持续优化时几乎不再被实现层牵着走。

