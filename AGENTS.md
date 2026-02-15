# Repository Guidelines (Atoma)

> A strict development guide for AI coding agents. Goal: **no compatibility burden, one-step convergence to the optimal architecture**.

## 0. Global Hard Rules

- **Always reply in Simplified Chinese.**
- **Never revert or overwrite existing changes you did not introduce.** Existing modifications in this repo are assumed to be important.
- Prioritize root-cause fixes; avoid temporary compatibility patches.
- Unless explicitly requested, do not add transition aliases / compatibility wrappers / deprecated dual paths.
- 命名重构默认**一步到位**：不保留旧名并存、不保留兼容别名、不保留过渡导出。
- 对“路径上下文已提供语义”的命名，禁止重复前缀（例如在 `atoma-types/runtime` 下使用 `WriteEntry`，而不是 `RuntimeWriteEntry`）。

---

## 1. Current Architecture Baseline (Must Follow)

### 1.1 Package and Module Boundaries

- `atoma-protocol` has been merged and must no longer be used as a standalone package.
- Protocol capabilities are unified in:
  - `atoma-types/protocol` (types)
  - `atoma-types/protocol-tools` (runtime tools)
- Root import from `atoma-types` is **forbidden** (`from 'atoma-types'`).
  - Only subpath imports are allowed: `atoma-types/{shared|core|runtime|client|protocol|protocol-tools|sync|observability|devtools|internal}`.

### 1.2 Dependency Direction (One-way)

- Required direction: `shared -> core -> protocol -> protocol-tools`
- `runtime/client/sync/...` may depend only downward; reverse dependencies are forbidden.
- **`core -> protocol` reverse dependency is forbidden.**

### 1.3 Protocol Tool Export Style

- Named exports only.
- `Protocol.xxx` facade style is forbidden.
- Recommended:
  - `import { buildQueryOp, assertOperationResults } from 'atoma-types/protocol-tools'`

### 1.4 Responsibility Separation (Hard Constraint)

- **Separation of responsibilities is mandatory.**
- Core modules must focus on domain algorithms and data structures, not app-entry validation or orchestration concerns.
- Runtime modules orchestrate execution flow and state wiring, not schema authoring concerns.
- Client modules validate/normalize user input and schema config before passing to runtime/core.
- Do not mix public API, orchestration logic, and low-level helpers in the same file layer when a clearer split is possible.

---

### 1.5 atoma-shared and atoma-types/shared Boundaries

- atoma-types/shared is type-only (scalar contracts only).
- atoma-shared is runtime utility foundation (ids/random/time/error/url/stable serialization/zod helpers).
- Runtime helper logic must not be duplicated across packages; prefer atoma-shared single-source utilities.
- atoma-core domain modules must not implement package-local random/uuid fallback logic.
- Default entity-id policy must be runtime-configurable; core may expose optional algorithms but must not hardcode one as the domain default.
- If a utility is used by 2+ packages and has no business semantics, it belongs in atoma-shared.

### 1.6 ID and Context Generation Principles

- Use one canonical runtime ID utility path for actionId/entityId/requestId/replicaId.
- Avoid ad-hoc Date.now() + Math.random() composition in feature packages.
- createOperationContext is responsible for context shaping (scope/origin/label/timestamp), not crypto fallback implementation.
- Snowflake-like generators are optional strategies only; they must not be the implicit global default.

## 2. Naming Design Principles

### 2.1 Naming Method (How to design names)

- Start from responsibility boundaries first, then pick names.
- Name by domain intent, not by implementation detail.
- Prefer the shortest name that remains unambiguous in its module scope.
- Remove context already encoded by path/layer; do not duplicate it in symbol names.
- Keep one concept mapped to one term across the whole repo.

### 2.2 Cross-layer Consistency

- Type names represent contracts; implementation names represent executors/holders of behavior.
- The same concept should keep the same lexical root across packages.
- If type and class concepts overlap, resolve local collisions at import sites (type aliasing), not by globally polluting names.
- Do not add suffixes/prefixes solely for historical compatibility.
- Rename must converge directly to target vocabulary across affected packages; do not keep old/new names side-by-side.

### 2.3 File Naming Strategy

- If the primary export is a class, file name uses **PascalCase**.
- If the primary export is function/type/helper-oriented, file name uses **camelCase**.
- File names must follow primary responsibility, not secondary helper content.
- Keep file names concise and semantic; avoid structural redundancy.

### 2.4 Public API Naming Strategy

- Public API names must be concise, semantic, and stable.
- Use clear action semantics (read/write/query/plan/apply/build) consistently across modules.
- Avoid overloaded generic words and hidden abbreviations.
- Option/config fields must describe behavior and intent, not internal mechanics.

### 2.5 Naming Quality Gates (must pass before merge)

- Can a reader infer responsibility from the name alone?
- Is any part of the name redundant with folder/module context?
- Is the term consistent with existing domain vocabulary?
- Will the name still be valid after foreseeable feature expansion?
- Is there a shorter form with equal clarity?

### 2.6 Domain Boundary Terms

- In `core`/`runtime`/`client` domains, use `StoreToken` and `storeName` consistently.
- In `protocol`/`sync`/`transport` domains, use `ResourceToken` and `resource`/`resources` consistently.
- Cross-domain mapping (`storeName` <-> `resource`) must happen only at boundary adapters.
- Do not introduce raw `string` fields for these concepts when a token type already exists.

### 2.7 Rename and Alias Policy

- Renaming is **full replacement**, not additive migration.
- After rename, old symbols must be deleted immediately; do not keep compatibility exports.
- `import { Xxx as Yyy }` is forbidden when alias only serves backward-compatibility naming retention.
- Alias is allowed only for true semantic collision at import site (e.g. protocol vs runtime same term in one file), and must not leak as public API.

---

## 3. Query and Transform Semantic Boundaries (Important)

### 3.1 Unified Query Entry

- Local query must go through `runtime.engine.query.evaluate`.
- Current fixed signature:
  - `evaluate({ state, query })`
  - where `state` is `StoreState<T>`.

### 3.2 Index Usage Principles

- If a real `StoreState` is provided, query should reuse its `indexes/matcher`.
- For temporary array queries (e.g. hook-only array scenarios), a temporary `StoreState` can be constructed with:
  - `indexes: null`
  - `matcher` passed through as needed.

### 3.3 Transform Usage Boundaries

- `outbound`: only for outbound write transformation (before sending).
- `writeback`: for applying remote responses / sync replay back to local state.
- `inbound`: for pre-write normalization.
- **Do not call `outbound` before local cache query.**

---

## 4. Import / Export Rules

### 4.1 Forbidden

- `from 'atoma-types'` root import is forbidden.
- `from 'atoma-protocol'` is forbidden.
- Star-namespace type imports like `import type * as Types from '../core'` are forbidden.

### 4.2 Recommended

- Use explicit named imports:
  - `import type { Entity, Query, StoreState } from 'atoma-types/core'`
- Keep barrel exports updated (e.g. `src/*/index.ts`).

---

## 5. Code Style

- Language: TypeScript (`strict`).
- Indentation: 4 spaces.
- Strings: single quotes.
- Semicolons: not required; follow existing file style.
- **Class names MUST use PascalCase.**
- Components/types: PascalCase.
- Variables/functions: camelCase.
- Constants: UPPER_SNAKE_CASE.

### 5.1 Implementation Pattern Preferences

- 对单次使用的中间结果，优先内联调用，避免无必要临时变量（例如：`disposers.push(...plugins.init(client))`）。
- 对“参数对象”风格函数，优先在函数签名处解构并显式标注类型（例如：`function f({ a, b }: Args)`），减少 `args.xxx` 噪音。
- 资源释放必须保持逆序语义；优先使用逆序 `for` / `while + pop`，不要用 `forEach` 承担逆序清理。

---

## 6. Build, Validation, and Workflow

### 6.1 Common Commands

- `pnpm build`: full workspace build.
- `pnpm typecheck`: full workspace typecheck (includes build chain).
- `pnpm test`: Vitest (headless).
- `pnpm test:ui`: Vitest UI.
- `pnpm demo:web`: run web demo.
- `pnpm start:docs`: run docs site.

### 6.2 Recommended Validation Order

1. Run impacted package typecheck: `pnpm --filter <pkg> run typecheck`
2. Run impacted package build: `pnpm --filter <pkg> run build`
3. Run full workspace check: `pnpm typecheck`

---

## 7. Repository-specific Implementation Contracts

- `atoma-types/sync` has been split into `outbox.ts / transport.ts / events.ts / config.ts`; `index.ts` is export-only.
- `atoma-types/shared/scalars` is the single source of base scalars (`EntityId/Version/Cursor/CursorToken`).
- Local query in `atoma-client/defaults/LocalBackendPlugin` must use `runtime.engine.query.evaluate({ state, query })`.
- `atoma-react` query hooks handling external arrays should construct temporary `StoreState` to reuse runtime query semantics.

---

## 8. Commit and PR Guidelines

- Follow Conventional Commits (`feat:` / `fix:` / `chore:` ...).
- PR description should include:
  - Change summary
  - Design rationale
  - Validation commands and results
  - UI screenshots/GIFs when applicable
- Prefer small, reviewable changes.

---

## 9. Conflict Resolution Priority

When rules conflict, apply this order:

1. Explicit user instruction in current turn
2. Hard rules in this file
3. Current repository architecture reality (code as source of truth)
4. Historical compatibility habits

**Default strategy: no compatibility retention; converge directly to target architecture.**
