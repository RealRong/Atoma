# Atoma DevTools（React Overlay）

这是一个可嵌入的 DevTools 浮层：UI 用 React 渲染，但可以挂载到任何框架（Vue/React/纯 JS）页面里。

## 设计要点

- 使用 Shadow DOM 隔离样式，避免 Tailwind/shadcn 影响宿主应用，也避免宿主样式污染 DevTools
- 通过 Atoma 的 `DevtoolsBridge` 订阅 store/index/queue/history/trace 快照

## 使用（示例）

```ts
import { mountAtomaDevTools } from 'atoma-devtools'

// 开发环境调用即可
mountAtomaDevTools()
```

## 在 Vue 中挂载（推荐：仅开发环境）

```ts
if (import.meta.env.DEV) {
    import('atoma-devtools').then(m => m.mountAtomaDevTools({ defaultOpen: false }))
}
```

## 注意

- DevTools 会通过 `enableGlobalDevtools()` 订阅全局 bridge；要看到 trace 事件，需要在 store 配置 `debug: { enabled: true, sampleRate: 1 }`
- 由于使用 Shadow DOM，Tailwind/shadcn 的样式不会污染宿主应用
