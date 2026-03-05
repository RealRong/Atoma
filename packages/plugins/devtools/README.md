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

## 状态

该包正在适配新的插件架构，当前只保留最小占位导出用于过渡，完整功能后续再恢复。
