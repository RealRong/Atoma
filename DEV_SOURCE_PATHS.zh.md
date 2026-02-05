# 开发期 paths 源码联调方案（编辑器优先）

## 目标与范围
- 让编辑器/TypeScript 语言服务在**不 build dist**的情况下，直接解析到 `packages/*/src`。
- 只影响**类型解析与跳转**，运行时仍按 `package.json` 的 `exports/main` 走 `dist`。
- 适合“本地改类型/源码，不启动进程”的场景；需要运行时再 build 即可。

## 方案要点
- 用 **一份**根目录 `tsconfig.paths.root.json` 集中维护所有 `paths`。
- 所有 `packages/*/tsconfig.json` 都继承这份配置，从而在包内也能解析到源码。
- 注意：`compilerOptions.paths` **不会深度合并**，包内一旦自定义 `paths` 会覆盖共享配置，必须手动合并。
- 为了让 root 版 paths 生效，**包内不要覆盖 `baseUrl`**（否则相对路径会错位）。

## 步骤（推荐）

### 1) 新增共享配置（根目录唯一入口）
在根目录新增 `tsconfig.paths.root.json`，由 `packages/*/tsconfig.json` 统一继承。

路径映射（以**仓库根目录**为基准，使用 `packages/...`）：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "atoma": ["packages/atoma/src/index.ts"],
      "atoma-types/internal": ["packages/atoma-types/src/internal/index.ts"],
      "atoma-backend": ["packages/atoma-backend/src/index.ts"],
      "atoma-backend-indexeddb": ["packages/atoma-backend-indexeddb/src/index.ts"],
      "atoma-backend-memory": ["packages/atoma-backend-memory/src/index.ts"],
      "atoma-client": ["packages/atoma-client/src/index.ts"],
      "atoma-core": ["packages/atoma-core/src/index.ts"],
      "atoma-devtools": ["packages/atoma-devtools/src/index.ts"],
      "atoma-history": ["packages/atoma-history/src/index.ts"],
      "atoma-history/*": ["packages/atoma-history/src/*"],
      "atoma-observability": ["packages/atoma-observability/src/index.ts"],
      "atoma-observability/*": ["packages/atoma-observability/src/*"],
      "atoma-protocol": ["packages/atoma-protocol/src/index.ts"],
      "atoma-protocol/*": ["packages/atoma-protocol/src/*"],
      "atoma-react": ["packages/atoma-react/src/index.ts"],
      "atoma-react/*": ["packages/atoma-react/src/*"],
      "atoma-runtime": ["packages/atoma-runtime/src/index.ts"],
      "atoma-runtime/*": ["packages/atoma-runtime/src/*"],
      "atoma-server": ["packages/atoma-server/src/index.ts"],
      "atoma-server/adapters": ["packages/atoma-server/src/adapters/index.ts"],
      "atoma-server/adapters/typeorm": ["packages/atoma-server/src/adapters/typeorm/index.ts"],
      "atoma-server/adapters/prisma": ["packages/atoma-server/src/adapters/prisma/index.ts"],
      "atoma-shared": ["packages/atoma-shared/src/index.ts"],
      "atoma-shared/*": ["packages/atoma-shared/src/*"],
      "atoma-sync": ["packages/atoma-sync/src/index.ts"],
      "atoma-sync/*": ["packages/atoma-sync/src/*"],
      "atoma-types": ["packages/atoma-types/src/index.ts"],
      "atoma-types/core": ["packages/atoma-types/src/core/index.ts"],
      "atoma-types/runtime": ["packages/atoma-types/src/runtime/index.ts"],
      "atoma-types/client": ["packages/atoma-types/src/client/index.ts"],
      "atoma-types/protocol": ["packages/atoma-types/src/protocol/index.ts"],
      "atoma-types/observability": ["packages/atoma-types/src/observability/index.ts"],
      "atoma-types/sync": ["packages/atoma-types/src/sync/index.ts"],
      "atoma-types/devtools": ["packages/atoma-types/src/devtools/index.ts"],
      "#client": ["packages/atoma-client/src/index.ts"],
      "#client/*": ["packages/atoma-client/src/*"],
      "#sync/*": ["packages/atoma-sync/src/*"]
    }
  }
}
```

### 2) 让所有包继承共享配置
把 `packages/*/tsconfig.json` 的 `extends` 指向 `../../tsconfig.paths.root.json`。  
同时确保：
- **不要在包内覆盖 `baseUrl`**；否则 `paths` 会相对包目录解析而失效。
- **不要再定义 `compilerOptions.paths`**；如必须保留，把共享 paths 和本地 paths 手动合并到同一个对象里。

## 维护规则
- 新增包或新增 `package.json` 子路径导出时，必须同步更新 `paths`。
- `paths` 只解决编辑器/TS 解析问题；运行时仍然需要 build。
- 如果编辑器仍报错，重启 TS Server（VSCode: “TypeScript: Restart TS Server”）。
