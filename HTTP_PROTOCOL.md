# Atoma HTTP 协议规范（REST + Batch）

本文件定义 Atoma 的**语言无关** HTTP 协议：前端（HTTPAdapter/BatchEngine）如何发请求，后端（Node/Java/PHP/...）如何解析参数并查询数据库，以及响应应返回的标准形态。

> 目标：不开 batch 时就是“普通 REST”；开启 batch 后所有读写都走 `/batch`（避免两套语义漂移）。

## 1. 基本约定

- **资源（resource）**：资源名字符串，例如 `post`、`comment`。
- **错误结构（StandardError）**：
  ```json
  { "error": { "code": "INVALID_QUERY", "message": "xxx", "details": "..." } }
  ```
  - `details`：可选；若存在，应为**机器可解析**的对象（plain JSON object），用于定位错误来源与参数位置。

### 1.1 Error.details（建议规范）

为便于跨语言客户端处理，建议后端在 `error.details` 里提供稳定字段（按需裁剪）：

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "Field not allowed: passwordHash",
    "details": {
      "kind": "field_policy",
      "resource": "post",
      "part": "where",
      "field": "passwordHash",
      "path": "where.passwordHash"
    }
  }
}
```

约束：
- `details` 必须可 JSON 序列化；不应包含原始异常对象（避免泄露内部信息）
- `kind` 建议用于机器分类（例如 `validation/field_policy/limits/access/internal` 等）

一致性测试向量：
- Node 参考实现内置协议向量见：`tests/server/protocol/vectors.ts`
- **分页信息（pageInfo）**：
  ```json
  { "pageInfo": { "hasNext": true, "cursor": "<token>", "total": 123 } }
  ```
  - `cursor`：用于续页的 cursor token（见第 4 节）。
  - `total`：仅在 offset + includeTotal 时返回；cursor 模式默认不返回 total。

## 2. REST 协议（默认路径）

### 2.1 路由

- 列表查询：`GET /:resource`
- 单条查询：`GET /:resource/:id`
- 创建：`POST /:resource`
- 更新：`PUT /:resource/:id`（全量更新）
- Patch：`PATCH /:resource/:id`（若 body 含 `patches[]` 则视为 patch，否则可视为 update）
- 删除：`DELETE /:resource/:id`
- 未匹配任一路由：HTTP 404
  ```json
  { "error": { "code": "NOT_FOUND", "message": "No route matched" } }
  ```

### 2.2 查询参数（GET /:resource）

#### 2.2.1 分页

- offset 分页（默认）：
  - `limit`：正整数，默认 `50`
  - `offset`：非负整数，可选（不传等价于从 0 开始）
  - `includeTotal`：`true|false`，可选；不传默认 `true`
- cursor 分页（keyset）：
  - `limit`：正整数，默认 `50`
  - `after`：cursor token（下一页）
  - `before`：cursor token（上一页）
  - `after` 与 `before` 互斥；只要出现其一，即视为 cursor 分页

#### 2.2.2 排序（orderBy）

- 形式：重复参数 `orderBy=field:direction`
  - `direction`：`asc` 或 `desc`（不填/非法按 `desc` 处理）
- 示例：
  - `orderBy=createdAt:desc&orderBy=id:asc`

> 备注：后端在执行 keyset 分页时应保证排序稳定；若请求未显式包含 `id`（或配置的 `idField`），建议追加 `id` 作为 tie-breaker。

#### 2.2.3 过滤（where，bracket 规范）

基础等值：
- `where[field]=value`

操作符：
- `where[field][op]=value`

in 操作符（数组）：
- `where[field][in][]=1&where[field][in][]=2`

支持的 op（建议后端按白名单实现，并对未知 op 返回 `INVALID_QUERY`）：
- `in`（数组）
- `gt/gte/lt/lte`（数值/日期比较）
- `startsWith/endsWith/contains`（字符串）

强约束（规范要求后端严格执行，以保证多语言一致性）：
- 未知 op：HTTP 422 + `{ "error": { "code": "INVALID_QUERY", ... } }`
- `in` 必须是数组（仅接受 `where[field][in][]=` 形式的重复参数，或等价的数组结构）
- `startsWith/endsWith/contains` 的值必须是 string
- 所有 where 值仅允许 primitive（string/number/boolean），禁止 object/array 嵌套（`in` 除外）

示例：
- `where[postId]=1`
- `where[age][gte]=18`
- `where[id][in][]=1&where[id][in][]=2`

类型转换建议（跨语言实现保持一致）：
- `true` → boolean `true`
- `false` → boolean `false`
- 纯数字字符串 → number
- 其他 → string

#### 2.2.4 字段选择（fields，可选）

为减少 payload，可通过 `fields` 指定仅返回部分字段（sparse fieldset）：

- 形式：`fields=field1,field2,field3`
- 示例：`GET /post?fields=id,title,createdAt`

说明：
- `fields` 仅影响返回字段集合；后端仍需执行自身的字段/资源安全策略（不能信任客户端）。
- 若未传 `fields`：后端默认返回全字段（具体由 adapter/ORM 决定）。

### 2.3 REST 响应形态

#### 2.3.1 GET /:resource（列表）

```json
{ "data": [ ... ], "pageInfo": { "hasNext": true, "cursor": "<token>", "total": 123 } }
```

#### 2.3.2 GET /:resource/:id（单条）

- 命中：
  ```json
  { "data": { ... } }
  ```
- 未命中：HTTP 404
  ```json
  { "error": { "code": "NOT_FOUND", "message": "Not found" } }
  ```

#### 2.3.3 写操作（POST/PUT/PATCH/DELETE）

- 创建：HTTP 201
  ```json
  { "data": { ... } }
  ```
- 更新/patch：HTTP 200
  ```json
  { "data": { ... } }
  ```
- 删除：HTTP 204（无 body）

## 3. Batch 协议（性能路径）

### 3.1 端点

- `POST /batch`

### 3.2 请求结构

#### 3.2.1 query（批量读）

```json
{
  "action": "query",
  "queries": [
    {
      "resource": "comment",
      "requestId": "r1",
      "params": {
        "where": { "postId": 1 },
        "fields": ["id", "title", "createdAt"],
        "orderBy": [{ "field": "createdAt", "direction": "desc" }],
        "page": { "mode": "offset", "limit": 20, "offset": 0, "includeTotal": true }
      }
    }
  ]
}
```

Batch 的关键约束：
- `params.page` **必填**（REST 会自动补默认 page；Batch 不会）。

`fields`（可选）：
- 作用：同 REST，减少返回字段集合（sparse fieldset）
- 建议形态：`string[]`（数组）

`page`：
- offset：
  - `{ "mode":"offset", "limit":20, "offset":0, "includeTotal":true }`
- cursor：
  - `{ "mode":"cursor", "limit":20, "after":"<token>" }`
  - `{ "mode":"cursor", "limit":20, "before":"<token>" }`

#### 3.2.2 写操作（create/update/patch/delete/bulk*）

示例（bulkUpdate）：
```json
{
  "action": "bulkUpdate",
  "resource": "post",
  "payload": [{ "id": 1, "data": { "title": "x" }, "baseVersion": 0, "meta": { "idempotencyKey": "k1" } }]
}
```

写入 payload 约定（推荐/协议形态）：
- `bulkCreate.payload[]`：`{ "data": <object>, "meta"?: { "idempotencyKey"?: "<string>" } }`
- `bulkUpdate.payload[]`：`{ "id": <id>, "data": <object>, "baseVersion": <number>, "meta"?: { "idempotencyKey"?: "<string>" } }`
- `bulkPatch.payload[]`：`{ "id": <id>, "patches": <patch[]>, "baseVersion": <number>, "timestamp"?: <number>, "meta"?: { "idempotencyKey"?: "<string>" } }`
- `bulkDelete.payload[]`：`{ "id": <id>, "baseVersion": <number>, "meta"?: { "idempotencyKey"?: "<string>" } }`

说明：
- `meta` 是协议元信息容器（不属于业务数据，不会写入数据库）。
- `baseVersion` 在除 create 外的写入中建议视为必填，用于乐观锁/冲突检测（缺失应返回 422）。

### 3.3 响应结构

```json
{
  "results": [
    {
      "requestId": "r1",
      "data": [ ... ],
      "pageInfo": { "hasNext": true, "cursor": "<token>", "total": 123 },
      "partialFailures": [{ "index": 1, "error": { "code": "FAIL", "message": "..." } }],
      "error": { "code": "QUERY_FAILED", "message": "..." }
    }
  ]
}
```

说明：
- `query` 批量读：每个 query 对应一个 result，通过 `requestId` 关联。
- `bulk*`：通常只有一个 result；失败可用 `partialFailures` 精确标注失败项。
- **HTTP status 规则（重要）**：
  - 若请求在解析/校验/guard 阶段失败（例如 `INVALID_QUERY`/`ACCESS_DENIED`/字段策略命中等）：返回非 200（通常 4xx），响应体为顶层 `{ "error": ... }`，不返回 `results`。
  - 若请求本身合法但某个 query 执行失败（adapter 抛错等）：HTTP 200，失败项写入对应 `results[i].error`（通常 `code='QUERY_FAILED'`）。

## 4. Cursor Token（keyset）规范

cursor token 的语义：把当前页边界行（after=最后一条；before=第一条）按 `orderBy` 字段顺序取值，编码为 token，用于下一次续页。

编码建议（与 Node 参考实现对齐）：
- payload：`{ "v": [value1, value2, ...] }`（数组顺序与最终用于 keyset 的 `orderBy[]` 一致）
- JSON → base64url（去掉 `=` padding，`+`→`-`，`/`→`_`）

> 建议：后端在执行 keyset 分页时，确保 `orderBy` 最终包含一个唯一 tie-breaker（默认 `id`），以避免漏/重。

cursor token 无效（解码/结构/字段数不匹配等）时，建议返回：
- HTTP 422
- `{ "error": { "code": "INVALID_QUERY", "message": "Invalid cursor token" } }`

## 5. 错误码与 HTTP Status（建议）

统一错误 body：
```json
{ "error": { "code": "...", "message": "..." } }
```

常见映射建议：
（Node 参考实现已按以下规则实现，并由协议向量测试覆盖。）

- 400：
  - `INVALID_BODY`（例如 `/batch` body 不是 JSON object）
  - `BAD_REQUEST`（URL/解析异常等）
- 403：`ACCESS_DENIED` / `RESOURCE_NOT_ALLOWED`
- 404：
  - `NOT_FOUND`（未匹配路由）
  - `NOT_FOUND`（GET /:resource/:id 未命中）
- 413：`PAYLOAD_TOO_LARGE`
- 422：`INVALID_REQUEST` / `INVALID_QUERY` / `INVALID_WRITE` / `INVALID_PAYLOAD` / `INVALID_ORDER_BY` / `UNSUPPORTED_ACTION` / `TOO_MANY_*`
- 501：`ADAPTER_NOT_IMPLEMENTED`
- 500：`INTERNAL`（未知异常；不透传内部错误）

一致性测试向量：
- Node 参考实现：`tests/server/protocol/vectors.ts`（含 normalize 与 handler/status 语义）
