# Atoma Plugins 统一命名与文件组织规范

> 适用范围：`packages/plugins/*` 下所有插件包  
> 目标：命名一致、目录清晰、可扩展、可维护

## 目录结构规范（推荐模板）
```
packages/plugins/<plugin-name>/
├─ package.json
├─ tsconfig.json
├─ tsup.config.ts
├─ README.md            # 可选，面向用户说明
├─ README.zh-CN.md      # 可选
└─ src/
   ├─ index.ts          # 统一出口（必需）
   ├─ plugin.ts         # 插件工厂（必需）
   ├─ types.ts          # 插件公共类型（可选）
   ├─ runtime/          # 运行期模块（可选）
   ├─ transport/        # IO/网络/协议层（可选）
   ├─ storage/          # 本地存储或缓存（可选）
   ├─ devtools/         # devtools 相关（可选）
   ├─ ui/               # 仅 devtools/React 类插件需要（可选）
   └─ internal/         # 内部实现细节（可选）
```

## 文件命名规范
### 通用规则
- **目录名**：`kebab-case`
- **非 React 代码文件**：`kebab-case.ts`
- **React 组件文件**：`PascalCase.tsx`
- **入口文件**：`index.ts` 固定

### 推荐命名映射
- `xxxPlugin` → `plugin.ts`
- `xxxOptions` → `types.ts`
- `XxxOpsClient` → `ops-client.ts`
- `XxxDriver` → `driver.ts`
- `XxxTransport` → `transport/*`

## 代码命名规范
- 插件工厂：`xxxPlugin()`（函数式，不导出 class）
  - 例如：`httpBackendPlugin()`、`memoryBackendPlugin()`
- Options 类型：`XxxPluginOptions`
- Driver 类型：`XxxDriver`
- 内部类（若必须）：以 `Xxx*` 命名，文件仍采用 `kebab-case`

## 插件出口规范（`src/index.ts`）
统一导出：
- `xxxPlugin`（主插件工厂）
- `XxxPluginOptions`（配置类型）
- 若有可复用能力：导出 `XxxClient`/`XxxDriver`

示例：
```ts
export { httpBackendPlugin } from './plugin'
export type { HttpBackendPluginOptions } from './types'
export { HttpOpsClient } from './ops-client'
```

## 插件实现的推荐分层
### Backend 类插件（HTTP/Memory/IndexedDB）
```
src/
├─ index.ts
├─ plugin.ts
├─ types.ts
├─ ops-client.ts
└─ internal/
   └─ ...
```

### Sync 类插件
```
src/
├─ index.ts
├─ plugin.ts
├─ types.ts
├─ drivers/            # sync driver / subscribe driver
├─ engine/
├─ lanes/
├─ storage/
├─ internal/
└─ devtools/
```

### Devtools 类插件
```
src/
├─ index.ts
├─ plugin.ts
├─ runtime/
└─ ui/                 # React 组件
```

## 约束与约定
- **禁止默认副作用**：插件必须显式注册/启用
- **不导出 class 插件**：统一函数式工厂，便于组合与测试
- **内部实现隔离**：非导出模块放 `internal/`
- **类型集中**：对外类型统一放 `types.ts`
- **出口稳定**：`index.ts` 只做 re-export

## 现状与目标差异提示（后续可逐步对齐）
当前插件包中存在：
- 文件名大小写不统一（如 `MemoryOpsClient.ts`）
- 插件实现与 client/ops 混放（如 `httpBackendPlugin.ts` 与 `backend/`）
- 可复用模块散落在 `src/` 根目录

建议逐步迁移为上述结构与命名规范，保持代码行为不变。
