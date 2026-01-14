# `src/protocol` 内部结构梳理与重组建议（不改变对外 API）

> 目标：在保持对外 API 形态不变（`Protocol.xx.xx` + `#protocol` 的 type exports）的前提下，让 `src/protocol` 更“可读、可教、可维护”，更适合开源贡献者快速上手。

## 1. 现状：`src/protocol` 文件排布与对外入口

### 1.1 当前目录树（简化）

```
src/protocol/
  index.ts
  Protocol.ts
  ops/
    ops.ts
    types.ts
    validate.ts
    meta.ts
    encodeWrite.ts
    http/
      index.ts
      constants.ts
    query/
      index.ts
      types.ts
    changes/
      index.ts
      types.ts
  shared/
    scalars/
      index.ts
      types.ts
    meta/
      index.ts
      types.ts
    ids/
      index.ts
      fns.ts
    error/
      index.ts
      fns.ts
      types.ts
    envelope/
      index.ts
      compose.ts
      parse.ts
      types.ts
    sse/
      index.ts
      constants.ts
      format.ts
      parse.ts
```

### 1.2 对外 API 的“真实契约”在哪里

- `#protocol` 路径别名指向 `src/protocol/index.ts`（由 `tsconfig.json` 的 `paths` 配置决定）。
- `src/protocol/index.ts` 目前做两件事：
  - `export { Protocol } from './Protocol'`
  - 统一 re-export 所有对外需要的 `type`（`EntityId` / `Meta` / `Envelope` / `Operation*` / `QueryParams` / `Change*` 等）。
- `src/protocol/Protocol.ts` 定义 `export const Protocol = { http, error, ids, ops, sse, collab: {} } as const`。
  - 也就是说：对外 API 的稳定性核心，是 `Protocol` 这个对象的 shape（键名与嵌套结构）保持不变。

因此，“不改变对外 API”的最小约束可以表述为：

1) `src/protocol/index.ts` 继续作为唯一对外入口（或者至少仍然能从这里 import 到所有既有 type/值）。  
2) `Protocol` 对象的结构与既有字段路径保持兼容（例如 `Protocol.http.paths.OPS`、`Protocol.ops.validate.assertOpsRequestV1`、`Protocol.error.wrap` 等）。

## 2. 现状痛点（为什么会觉得“切得碎”）

1) **过多“只做转发”的 `index.ts`**  
   例如 `ops/http/index.ts` 仅 `export { http } from './constants'`；`ops/query/index.ts` 仅 re-export types。对新手来说跳转成本高，信息密度低。

2) **`shared/` 的语义不清**  
   在 `protocol` 子域内再放一层 `shared`，会让读者产生“这是被谁 shared？”的疑问。对外来看，这些其实就是协议层的基础模块（error/envelope/meta/scalars…），并不“次要”。

3) **“小文件太小 + 大文件太大”同时存在**  
   - `scalars/types.ts` 只有几行 type，`index.ts` 只是转发；
   - `ops/validate.ts` 可能非常长且承载了多类校验逻辑，读者定位某个规则会困难。

4) **版本化线索分散**  
   你已经用 `assert*V1` 在函数名里表达版本，但文件结构上没有显式的“版本区域”，新手很难一眼知道“V1 的定义/校验/兼容策略”集中在哪里。

5) **模块边界（协议 vs 传输）未显式表达**  
   `http.paths`、`sse`、`envelope`、`ops` 混在同一层级是合理的，但内部组织可以更“按心智模型分区”：  
   - 协议核心：`ops`、`envelope`、`meta`、`error`、`scalars`  
   - 传输适配：`http`、`sse`（更像 transport helpers）

## 3. 重组原则（保证开源可读性与不破坏 API）

### 3.1 单入口原则

- **对外**：只从 `src/protocol/index.ts` 导出（值 + types）。
- **对内**：每个子模块也遵循“一个明确入口文件”，让读者知道应该从哪里开始看。

### 3.2 Facade 保持稳定

- `src/protocol/Protocol.ts` 继续扮演 facade（门面）角色：把各子模块组装为固定结构的 `Protocol` 对象。
- 内部怎么挪文件、怎么拆/合并，只要最终 `Protocol.*` 的路径不变即可。

### 3.3 让“文件名”表达意图

建议统一约定：
- `types.ts`：只放类型/接口（或放到同文件里但用明显分段也行）
- `constants.ts`：常量
- `parse.ts` / `format.ts` / `compose.ts`：纯转换/序列化
- `validate/`：校验逻辑（按领域拆分）
- `internal/`：实现细节（不希望被外部依赖的部分）

### 3.4 版本化显式化

将 `V1` 从“函数后缀”升级为“目录结构”，把读者的搜索路径从：
> “到处 grep `V1`”
变为：
> “打开 `v1/` 目录看所有 V1 的类型/校验/兼容策略”

## 4. 推荐的目标结构（保持 `Protocol.xx.xx` 不变）

下面给出一个推荐结构（兼顾“减少碎片”与“拆大文件”）：

```
src/protocol/
  index.ts              # 对外唯一入口（保持）
  Protocol.ts           # Protocol facade（保持 shape）

  core/                 # 协议核心（与 transport 区分）
    scalars.ts          # EntityId/Cursor/Version（合并原 scalars/*）
    meta.ts             # Meta + ensureMeta（合并原 meta/*）
    error/
      index.ts          # Protocol.error 的入口（保留，易读）
      types.ts
      error.ts          # create/wrap/withTrace 等实现（可由 fns.ts 合并/改名）
    envelope/
      index.ts          # Protocol.ops.parse/compose 最终依赖这里
      types.ts
      envelope.ts       # ok/error/parseEnvelope/compose（可合并 compose+parse）

  ops/
    index.ts            # Protocol.ops 的入口（替代 ops/ops.ts；文件名更直观）
    types.ts            # Operation*/Result*/OpsRequest/Response 等
    encodeWrite.ts
    meta.ts

    validate/
      index.ts          # 组合导出 assert*V1（保持现有函数名）
      v1/
        meta.ts
        query.ts
        write.ts
        changesPull.ts
        opsRequest.ts
        operation.ts

    query.ts            # QueryParams/PageInfo/OrderBy（合并原 query/*）
    changes.ts          # Change*（合并原 changes/*）

  transport/
    http.ts             # Protocol.http（合并 http/index+constants）
    sse/
      index.ts          # Protocol.sse
      constants.ts
      format.ts
      parse.ts

  ids.ts                # Protocol.ids（合并 ids/index+fns）

  collab/               # 预留（现在是 Protocol.collab: {}）
    index.ts
```

要点：
- **减少“纯转发文件”**：能合并就合并，避免 `index.ts -> constants.ts` 这种两跳。
- **拆分 `validate` 巨文件**：按“校验对象”拆到 `validate/v1/*`，再在 `validate/index.ts` 聚合导出。
- **按心智模型分区**：`core/`（协议核心）与 `transport/`（http/sse）清晰分开；`ids` 作为跨域基础工具可放根层或 `core/`。

> 这只是推荐方案。你也可以选择“更扁平”的变体（把 `core/`、`transport/` 取消，全部放在 `src/protocol/` 下），但分区对新手理解更友好。

## 5. 如何做到“不改变对外 API”

内部重构的关键技巧是：**Facade 不变、内部可迁移**。

### 5.1 `Protocol` 对象作为稳定门面

保持这些字段路径继续存在（示例）：
- `Protocol.http.paths.OPS`
- `Protocol.error.create / wrap / withTrace / ...`
- `Protocol.ids.createOpId / createIdempotencyKey`
- `Protocol.ops.parse.envelope / compose.ok / validate.assertOperationV1 / meta.newWriteItemMeta / encodeWriteIntent`
- `Protocol.sse.events.NOTIFY / parse.notifyMessage / format.notify`

即使内部文件移动/拆分，也只需要在 `Protocol.ts` 内重新 import 对应模块并组装成相同结构。

### 5.2 `src/protocol/index.ts` 继续做“对外类型出口”

`#protocol` 目前被大量用作 type imports：`import type { EntityId, Meta, Operation } from '#protocol'`。  
因此，重构时只要 `src/protocol/index.ts` 依旧导出这些类型名即可，不要求这些类型仍来自原来的文件路径。

### 5.3 迁移过程中的“过渡层”策略（建议）

为了避免一次性大挪动造成 PR 过大、review 困难：

1) 先建立新结构（例如新增 `core/`、`transport/`、`ops/validate/v1/`）  
2) 在旧路径保留薄的 re-export（仅内部使用的 import 路径）  
3) 逐步把仓库内的 import 从旧路径迁到新路径  
4) 最后删除旧路径（或保留一段时间以降低合并冲突）

> 这个策略能让每一步都“可运行/可测试”，更适合开源协作。

## 6. 具体的“减碎 + 易学”改动建议清单

### 6.1 合并“信息密度过低”的文件

优先级（从最值得做开始）：
- `ops/http/index.ts` + `ops/http/constants.ts` → `transport/http.ts`
- `ops/query/index.ts` + `ops/query/types.ts` → `ops/query.ts`
- `ops/changes/index.ts` + `ops/changes/types.ts` → `ops/changes.ts`
- `shared/scalars/index.ts` + `shared/scalars/types.ts` → `core/scalars.ts`
- `shared/meta/index.ts` + `shared/meta/types.ts` → `core/meta.ts`
- `shared/ids/index.ts` + `shared/ids/fns.ts` → `ids.ts`

这样做对新手的收益非常直接：减少跳转次数，打开一个文件就能看到“类型 + 实现/常量”的完整上下文。

### 6.2 拆分 `ops/validate.ts`（按领域拆，而不是按技术拆）

推荐拆分维度：
- `meta` 校验：`meta.v / traceId / requestId / clientTimeMs`…
- `query` 校验：`where / orderBy / fields / paging`…
- `write` 校验：`items / entityId / baseVersion / value.id` 一致性…
- `changes.pull` 校验：`cursor / limit / resources`…
- 请求壳：`OpsRequest`、`Operation` 顶层结构

然后由 `validate/index.ts` 输出当前稳定 API：  
`assertOpsRequestV1 / assertOperationV1 / assertOutgoingOpsV1` 等（名字不变，只是实现来源换了）。

### 6.3 把版本显式放到目录里

落地规则：
- **只要函数名里有 `V1`，实现就应该在 `v1/` 子目录里**  
  这样读者能从“函数名”直达“文件位置”，形成强一致性。

### 6.4 给新手一条阅读路径（建议写在未来的 `src/protocol/README.md`）

阅读顺序建议（最符合“先知道协议长什么样，再看工具函数”）：
1) `Protocol.ts`（有哪些模块）
2) `ops/types.ts`（协议核心数据结构）
3) `core/envelope/*`（请求/响应壳）
4) `ops/validate/*`（协议合法性规则）
5) `transport/http.ts` 与 `transport/sse/*`（对接具体传输）
6) `error/*` 与 `meta/scalars/ids`（基础设施）

## 7. 你提出的“更适合开源”的落地建议（非代码层）

1) **在 PR/Issue 模板中强调**：修改协议需要同时更新 `Protocol` facade 与 `#protocol` types exports。  
2) **把“协议的最小规范”写清楚**：例如 meta.v 的含义、envelope 格式、ops 三类 kind。  
3) **保持文件名与导出对象一致**：例如 `transport/http.ts` 输出 `http` 常量对象，读者不会迷路。

---

如果你愿意，我也可以基于这份文档再补一个“具体迁移步骤清单”（每一步涉及哪些文件/如何拆分 `validate.ts` 的模块边界），用于后续开源 PR 的拆分与排期。

