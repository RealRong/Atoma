# Atoma DevTools（React Overlay, Inspector）

这是一个可嵌入的 DevTools 浮层（UI 用 React 渲染），可以挂载到任何框架（Vue/React/纯 JS）页面里。

它在同一个包内同时提供：
- Inspector（运行时快照/订阅/全局 registry）
- Shadow DOM overlay UI（React 渲染）

以 **Client first + Snapshot first** 的方式展示运行时状态：clients → stores/indexes/sync/history。

## 设计要点

- 使用 Shadow DOM 隔离样式，避免 Tailwind/shadcn 影响宿主应用，也避免宿主样式污染 DevTools
- 数据源来自 `atoma-devtools` 自己的 Inspector（不依赖 client 内置字段；通过插件注册）
- 支持多 client：面板内可切换选中 client

## 使用（示例）

```ts
import { createClient } from 'atoma/client'
import { devtoolsPlugin, mountAtomaDevTools } from 'atoma-devtools'

const client = createClient({
    /* ... */
    plugins: [devtoolsPlugin({ label: 'app' })]
})

// 开发环境调用即可（UI 读取全局 registry）
mountAtomaDevTools()
```

## 在 Vue 中挂载（推荐：仅开发环境）

```ts
if (import.meta.env.DEV) {
    import('atoma-devtools').then(m => m.mountAtomaDevTools({ defaultOpen: false }))
}
```

## 限制

- Trace 面板（Observability debug-event）暂未接入 Inspector，后续阶段补齐
