# Atoma Zero-Config Demo

这个 demo 展示了：

- 后端：Express + TypeORM + SQLite，通过 `atoma/server` 的 `createAtomaServer` 自动得到 REST + `/api/batch` 批量能力
- 前端：React + `HTTPAdapter(batch: true)`，同一事件循环内的多次写操作会自动合并成一个 `/api/batch` 请求

## 重要变更（hooks 迁移）

Atoma 的 React 侧 hooks / registry 能力已迁移到 `atoma/react`，DevTools UI 则迁移到独立的 `atoma-devtools`（React Overlay），因此本 demo 中：

- `defineEntities` / `createAtomaStore` 从 `atoma/react` 导入（通过 `.defineClient({ defaultAdapterFactory })` 绑定默认适配器工厂）
- DevTools 使用 `atoma-devtools` 的 `mountAtomaDevTools()`
- 适配器、关系构建器、类型等仍从 `atoma` / `atoma/server` 导入

## 运行

在仓库根目录执行：

```bash
cd demo/zero-config
npm install
npm run dev
```

- 前端：http://localhost:5173（Vite 代理 `/api` -> http://localhost:3000）
- 后端：http://localhost:3000
- SQLite 文件：`demo/zero-config/.tmp/atoma-zero-config.sqlite`
