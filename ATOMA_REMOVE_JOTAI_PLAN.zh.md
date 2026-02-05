# Atoma 去除 Jotai 的完整重构方案（先文档，后改代码）

> 目标：彻底移除 Jotai 依赖，用更轻量可控的自研 StoreState 取代。
> 现阶段无用户包袱，允许大规模重构。

## 背景与动机
当前 Jotai 只承担“可订阅 Map 容器”的职责：
- 每个 store 只有一个 atom
- React 订阅通过 `useSyncExternalStore` 完成
- 不使用 Jotai 的派生 atom / 组合能力

因此 Jotai 在当前架构里是**过重依赖**。

## 目标
- 移除 Jotai 依赖与类型（runtime、types、core、client 等）
- 保留现有对外 API 和行为一致性
- 更简单的 StoreState：`getSnapshot / setSnapshot / subscribe`
- 允许未来扩展：批量更新、事务、版本号、差量通知

## 非目标
- 不改对外 CRUD API
- 不改 atoma-react hooks 行为
- 不做向后兼容（无用户）

---

## 设计方案

### 1) 新的 StoreState 抽象
定义一个独立、最小接口：

```ts
// packages/atoma-types/src/runtime/storeState.ts
import type { EntityId } from '../protocol'
import type * as Types from '../core'

type StoreSnapshot<T extends Types.Entity> = ReadonlyMap<EntityId, T>

type StoreListener = () => void

type StoreState<T extends Types.Entity> = {
  getSnapshot: () => StoreSnapshot<T>
  setSnapshot: (next: StoreSnapshot<T>) => void
  subscribe: (listener: StoreListener) => () => void
}
```

支持扩展能力（可选，后续再加）：
- `getVersion()` / `incrementVersion()`
- `batch(fn)`
- `notifyChangedIds(changedIds)`

### 2) 新增简单实现（自研）
直接在 runtime 内部实现：

```ts
// packages/atoma-runtime/src/store/StoreState.ts
class SimpleStoreState<T> implements StoreState<T> {
  private snapshot: ReadonlyMap<EntityId, T> = new Map()
  private listeners = new Set<() => void>()

  getSnapshot() { return this.snapshot }
  setSnapshot(next) {
    this.snapshot = next
    for (const l of this.listeners) l()
  }
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
```

### 3) StoreHandle 替换
把 `StoreHandle` 中的 `atom`/`jotaiStore` 替换成：

```ts
state: StoreState<T>
```

并删除 `JotaiStore` 类型。

### 4) runtime / read / write / stateWriter 全面改造
所有 `handle.jotaiStore.get(atom)` 替换为 `handle.state.getSnapshot()`
所有 `handle.jotaiStore.set(atom, map)` 替换为 `handle.state.setSnapshot(map)`

### 5) StoreBindings 输出层
StoreBindings 的 `source` 直接读 `handle.state`：

```ts
source: {
  getSnapshot: () => handle.state.getSnapshot(),
  subscribe: (listener) => handle.state.subscribe(listener)
}
```

### 6) 依赖清理
移除以下依赖：
- `jotai` / `jotai/vanilla` / `jotai/vanilla/utils`

涉及修改：
- `packages/*/package.json`
- `tsup.config.ts`
- `atoma-types/src/core/runtime.ts`（删除 JotaiStore）
- `atoma-types/src/runtime/handleTypes.ts` / `runtimeTypes.ts`

---

## 影响范围（文件级）

### atoma-types
- 新增 `src/runtime/storeState.ts`
- 修改 `src/runtime/handleTypes.ts`：替换 jotai 字段
- 修改 `src/runtime/runtimeTypes.ts`：删除 `JotaiStore`
- 修改 `src/core/runtime.ts`：移除 JotaiStore alias
- 更新 `src/runtime/index.ts` 导出 storeState

### atoma-runtime
- 新增 `src/store/StoreState.ts`（SimpleStoreState）
- 修改 `src/store/StoreFactory.ts` 初始化 state
- 修改 `src/store/StoreStateWriter.ts`
- 修改 `src/runtime/flows/ReadFlow.ts`
- 修改 `src/runtime/flows/WriteFlow.ts`
- 修改 `src/runtime/flows/write/prepare.ts`
- 修改 `src/runtime/flows/write/finalize.ts`（若有访问）
- 修改 `src/runtime/Runtime.ts`（移除 Jotai store 初始化）

### atoma-client / atoma-core / atoma
- 删除 Jotai 依赖
- 清理 tsup external

### atoma-history
- 替换 `Atom` 类型引用（若仍绑定 Jotai）

---

## 风险与对策

风险：
- 现有 Jotai store 具备的订阅语义被破坏

对策：
- 保持“全量订阅 + full snapshot”一致
- 对 hooks 行为保持不变（依旧 useSyncExternalStore）
- 新 StoreState 行为严格等价

---

## 执行顺序（建议）
1) 在 atoma-types 引入 StoreState 抽象
2) 在 atoma-runtime 引入 SimpleStoreState 并替换 StoreHandle
3) 修改 read/write/stateWriter 流程
4) 替换 StoreBindings source 获取方式
5) 清理 Jotai 依赖与类型
6) typecheck / build

---

## 预期收益
- runtime 更轻、更独立（无 UI 状态库依赖）
- 类型与依赖树显著简化
- 未来可引入更合适的订阅/事务模型
- 更易集成非 React 场景（node、worker、server）

