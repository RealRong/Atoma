# Atoma DevTools（React Overlay, vNext Inspector）

这是一个可嵌入的 DevTools 浮层（UI 用 React 渲染），可以挂载到任何框架（Vue/React/纯 JS）页面里。

它基于 `atoma/devtools`（vNext Inspector），以 **Client first + Snapshot first** 的方式展示运行时状态：clients → stores/indexes/sync/history。

## 设计要点

- 使用 Shadow DOM 隔离样式，避免 Tailwind/shadcn 影响宿主应用，也避免宿主样式污染 DevTools
- 数据源来自 `atoma/devtools`（不再依赖旧 `DevtoolsBridge` 事件流）
- 支持多 client：面板内可切换选中 client

## 使用（示例）

```ts
import { mountAtomaDevTools } from 'atoma-devtools'

// 开发环境调用即可（内部会自动 devtools.enableGlobal()）
mountAtomaDevTools()
```

## 在 Vue 中挂载（推荐：仅开发环境）

```ts
if (import.meta.env.DEV) {
    import('atoma-devtools').then(m => m.mountAtomaDevTools({ defaultOpen: false }))
}
```

## 限制

- Trace 面板（Observability debug-event）暂未接入 vNext Inspector，后续阶段补齐
