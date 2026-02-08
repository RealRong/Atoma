# Repository Guidelines (Atoma)

> A strict development guide for AI coding agents. Goal: **no compatibility burden, one-step convergence to the optimal architecture**.

## 0. Global Hard Rules

- **Always reply in Simplified Chinese.**
- **Never revert or overwrite existing changes you did not introduce.** Existing modifications in this repo are assumed to be important.
- Prioritize root-cause fixes; avoid temporary compatibility patches.
- Unless explicitly requested, do not add transition aliases / compatibility wrappers / deprecated dual paths.

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

## 2. File and Type Naming Conventions

### 2.1 File Naming

- If a file is class-led (its primary export is a class), use **PascalCase** file name.
  - Example: `Indexes.ts`, `NumberDateIndex.ts`, `TextIndex.ts`.
- If a file is function/helper/type-led, use **camelCase** file name.
  - Example: `build.ts`, `plan.ts`, `tokenize.ts`, `types.ts`.
- Keep file names short; prioritize domain semantics; avoid redundant suffixes.
- Avoid repeated suffixes inside semantic directories:
  - No `*Engine.ts` under `runtime/engine/*` unless the file is truly a class-led engine module.
  - Avoid `*Types.ts` (prefer concise names like `types.ts`, `api.ts`, `handle.ts`, `persistence.ts`, `contracts.ts`).

### 2.2 Type Naming

- Avoid “same name, different meaning”.
  - Example: plugin read result must use `PluginReadResult`, not conflict with core `QueryResult<T>`.
- Public type names should express semantics, not implementation details.

### 2.3 API Naming (Hard Constraint)

- Public API names must be **short, semantic, and industry-readable**.
- Prefer concise verb/noun forms (`buildIndex`, `planCandidates`, `applyWriteback`) over long redundant names.
- Avoid repeating context already encoded by module path (e.g., avoid `Index*` prefixes everywhere under `indexes/`).
- Avoid ambiguous generic names (`doThing`, `handler2`, `utilsFn`).

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
