# Atoma Devtools 重新设计方案（插件化 + 独立包 `atoma-devtools` + Shadow DOM UI）

状态：已落地（不需要兼容性；允许破坏式改动，一步到位）。  
目标：devtools 不再默认侵入 `client`；变成**可选装、可显式启用、可独立发布**的一套能力；并且 **只提供一个主入口**（无多子入口）。

---

## 1. 落地结果（当前仓库状态）

devtools 现在完全由一个 workspace 包承载：

- 包：`packages/atoma-devtools`（npm 名：`atoma-devtools`）
- 内容：
  - `src/runtime/**`：Inspector（registry + snapshot + subscribe）
  - `src/ui/**` + `src/mount.tsx`：Shadow DOM overlay UI（React 渲染）
- `atoma` 主包已移除 `atoma/devtools` 子入口，`createClient()` 也不再默认创建/挂载 inspector
- `AtomaClient` 类型不再包含 `Devtools` 必填字段

---

## 2. 对外 API（单入口，最小集合）

只允许从包主入口导入：

```ts
import { devtoolsPlugin, mountAtomaDevTools, Devtools } from 'atoma-devtools'
```

- `devtoolsPlugin(options?)`：Atoma client 插件（注册/卸载 registry entry）
- `mountAtomaDevTools(options?)`：挂载 Shadow DOM overlay UI（浏览器环境）
- `Devtools.global()`：读取全局 registry（供 UI/外部工具使用）

---

## 3. 内部机制（极简、行业常见）

### 3.1 registry key：`runtime.clientId`

- registry：`Map<string, ClientEntry>`
- key：`clientId = runtime.clientId`
- 不依赖 client 对象 identity；也不在 entry 内保存对 `client` 的强引用

### 3.2 插件职责（dev-only，可选装）

`devtoolsPlugin()` 在 `setup(ctx)` 时：
- `ensureEntry(runtime.clientId, label/meta)`
- attach runtime（store/index 快照与订阅）
- attach history（来自 `ctx.historyDevtools`）
- 尝试自动探测并 attach sync（若存在 `client.sync.devtools`，来自 `atoma-sync`）

`dispose()` 时：
- stop listeners（store/sync）
- `removeEntryById(runtime.clientId)`

### 3.3 UI 数据流

- overlay UI 只做一件事：`Devtools.global()` → list/get/snapshot/subscribe
- UI 不依赖 `client.Devtools`、也不依赖 `atoma` 主包内部路径

---

## 4. 分阶段方案（已完成）

- Phase 1：抽出 `packages/atoma-devtools`（runtime + UI） ✅
- Phase 2：插件化：`createClient` 不再默认挂载 inspector ✅
- Phase 3：迁移 UI：根目录 `devtools/` 已删除 ✅
- Phase 4：清理旧入口：移除 `atoma/devtools` ✅
