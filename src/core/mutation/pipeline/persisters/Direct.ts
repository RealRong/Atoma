import type { Patch } from 'immer'
import type { ObservabilityContext } from '#observability'
import { Protocol, type EntityId, type Operation, type StandardError, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions, type WriteResultData } from '#protocol'
import type { Entity, PersistWriteback, StoreDispatchEvent } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'
import { executeOps } from '../../../store/internals/opsExecutor'

type ApplySideEffects<T extends Entity> = {
    created?: T[]
    writeback?: PersistWriteback<T>
}

type WriteJob = {
    action: WriteAction
    items: WriteItem[]
    options?: WriteOptions
    intent?: 'created'
    requireCreatedData?: boolean
}

function isEntityId(v: unknown): v is EntityId {
    return typeof v === 'string' && v.length > 0
}

function requireBaseVersion(id: EntityId, value: unknown): number {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    throw new Error(`[Atoma] write requires baseVersion (missing version for id=${String(id)})`)
}

function resolveOptionalBaseVersion(value: unknown): number | undefined {
    const v = value && typeof value === 'object' ? (value as any).version : undefined
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    return undefined
}

function stableStringify(value: any): string {
    if (value === null || value === undefined) return String(value)
    if (typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`
}

function optionsKey(options: WriteOptions | undefined): string {
    if (!options) return ''
    return stableStringify(options)
}

function mergeWriteback<T extends Entity>(base: PersistWriteback<T> | undefined, next: PersistWriteback<T> | undefined): PersistWriteback<T> | undefined {
    if (!next) return base
    if (!base) return next

    const upserts = (base.upserts ?? []).concat(next.upserts ?? [])
    const deletes = (base.deletes ?? []).concat(next.deletes ?? [])
    const versionUpdates = (base.versionUpdates ?? []).concat(next.versionUpdates ?? [])

    return {
        ...(upserts.length ? { upserts } : {}),
        ...(deletes.length ? { deletes } : {}),
        ...(versionUpdates.length ? { versionUpdates } : {})
    }
}

function toWriteItemError(action: WriteAction, result: any): Error {
    const errObj: StandardError | undefined = result?.error
    const msg = (errObj && typeof (errObj as any).message === 'string') ? (errObj as any).message : 'Write failed'
    const err = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(err as any).error = errObj ?? result
    return err
}

function collectWritebackFromWriteResult<T extends Entity>(data: WriteResultData): PersistWriteback<T> | undefined {
    if (!data || !Array.isArray((data as any).results)) return

    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    const upserts: T[] = []

    for (const res of (data as any).results as any[]) {
        if (!res || res.ok !== true) continue
        const version = res.version
        if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
            versionUpdates.push({ key: String(res.entityId) as EntityId, version })
        }
        const value = res.data
        if (value && typeof value === 'object') {
            upserts.push(value as T)
        }
    }

    if (!versionUpdates.length && !upserts.length) return
    return {
        ...(upserts.length ? { upserts } : {}),
        ...(versionUpdates.length ? { versionUpdates } : {})
    }
}

function collectCreatedFromWriteResult<T extends Entity>(args: { action: WriteAction; data: WriteResultData; items: WriteItem[]; requireData: boolean }): T[] {
    const results = Array.isArray((args.data as any)?.results) ? ((args.data as any).results as any[]) : []
    const out: T[] = []

    for (const res of results) {
        if (!res || res.ok !== true) continue
        const index = typeof res.index === 'number' ? res.index : -1
        const rawData = res.data
        if (rawData && typeof rawData === 'object') {
            out.push(rawData as T)
            continue
        }
        if (args.requireData) {
            throw new Error('[Atoma] server-assigned create requires returning created results')
        }
        const fallback = index >= 0 ? args.items[index] : undefined
        const value = (fallback as any)?.value
        if (value && typeof value === 'object') out.push(value as T)
    }

    return out
}

function writeItemMetaForIndex(args: { operations: StoreDispatchEvent<any>[]; idx: number; fallbackClientTimeMs: number }): WriteItemMeta {
    const ticket = args.operations[args.idx]?.ticket
    const clientTimeMs = (typeof ticket?.clientTimeMs === 'number' && Number.isFinite(ticket.clientTimeMs))
        ? ticket.clientTimeMs
        : args.fallbackClientTimeMs
    const idempotencyKey = (typeof ticket?.idempotencyKey === 'string' && ticket.idempotencyKey)
        ? ticket.idempotencyKey
        : undefined

    return Protocol.ops.meta.ensureWriteItemMeta({
        meta: {
            clientTimeMs,
            ...(idempotencyKey ? { idempotencyKey } : {})
        },
        now: () => Date.now()
    })
}

function upsertWriteOptions(op: StoreDispatchEvent<any> | undefined): WriteOptions | undefined {
    if (!op || op.type !== 'upsert') return undefined
    const mode = op.upsert?.mode
    const merge = op.upsert?.merge

    const out: WriteOptions = {}
    if (typeof merge === 'boolean') out.merge = merge
    if (mode === 'strict' || mode === 'loose') out.upsert = { mode }
    return Object.keys(out).length ? out : undefined
}

async function runWriteJobs<T extends Entity>(args: {
    handle: PersisterPersistArgs<T>['handle']
    jobs: WriteJob[]
    context?: ObservabilityContext
}): Promise<ApplySideEffects<T>> {
    const ops: Operation[] = []
    const jobIndexByOpIndex: number[] = []

    for (let i = 0; i < args.jobs.length; i++) {
        const job = args.jobs[i]
        if (!job.items.length) continue
        ops.push({
            opId: args.handle.nextOpId('w'),
            kind: 'write',
            write: {
                resource: args.handle.storeName,
                action: job.action,
                items: job.items,
                ...(job.options ? { options: job.options } : {})
            }
        } as Operation)
        jobIndexByOpIndex.push(i)
    }

    if (!ops.length) return {}

    const results = await executeOps(args.handle as any, ops, args.context)
    if (results.length !== ops.length) {
        throw new Error('[Atoma] ops client returned mismatched results length')
    }

    let created: T[] | undefined
    let writeback: PersistWriteback<T> | undefined

    for (let opIndex = 0; opIndex < ops.length; opIndex++) {
        const result = results[opIndex]
        const job = args.jobs[jobIndexByOpIndex[opIndex] as number]
        if (!result || !job) throw new Error('[Atoma] missing operation result')

        if ((result as any).ok !== true) {
            const errObj = (result as any).error
            const msg = (errObj && typeof errObj.message === 'string') ? errObj.message : 'Operation failed'
            const err = new Error(`[Atoma] op failed: ${msg}`)
            ;(err as any).error = errObj
            throw err
        }

        const data = (result as any).data as WriteResultData
        const itemResults = Array.isArray((data as any)?.results) ? ((data as any).results as any[]) : []
        for (const r of itemResults) {
            if (!r) continue
            if (r.ok === true) continue
            throw toWriteItemError(job.action, r)
        }

        writeback = mergeWriteback(writeback, collectWritebackFromWriteResult<T>(data))

        if (job.intent === 'created') {
            const createdItems = collectCreatedFromWriteResult<T>({
                action: job.action,
                data,
                items: job.items,
                requireData: Boolean(job.requireCreatedData)
            })
            if (createdItems.length) {
                created = Array.isArray(created) ? created.concat(createdItems) : createdItems
            }
        }
    }

    return {
        ...(created?.length ? { created } : {}),
        ...(writeback ? { writeback } : {})
    }
}

export class DirectPersister implements Persister {
    async persist<T extends Entity>(args: PersisterPersistArgs<T>): Promise<PersisterPersistResult<T>> {
        const types = args.plan.operationTypes
        const fallbackClientTimeMs = args.metadata.timestamp

        if (types.length === 1 && types[0] === 'patches') {
            const metaForItem = () => Protocol.ops.meta.ensureWriteItemMeta({
                meta: { clientTimeMs: fallbackClientTimeMs },
                now: () => Date.now()
            })

            const touchedIds = new Set<EntityId>()
            ;(args.plan.patches as Patch[]).forEach(p => {
                const root = (p as any)?.path?.[0]
                if (isEntityId(root)) touchedIds.add(root)
            })
            if (touchedIds.size === 0) return

            const baseVersionByDeletedId = new Map<EntityId, number>()
            ;(args.plan.inversePatches as Patch[]).forEach(p => {
                if (p.op !== 'add') return
                if (!Array.isArray((p as any).path) || (p as any).path.length !== 1) return
                const id = (p as any).path[0]
                if (!isEntityId(id)) return
                const value = (p as any).value
                baseVersionByDeletedId.set(id, requireBaseVersion(id, value))
            })

            const upsertItems: WriteItem[] = []
            const deleteItems: WriteItem[] = []

            for (const id of touchedIds.values()) {
                const meta = metaForItem()
                const next = (args.plan.nextState as any as Map<EntityId, T>).get(id)
                if (next) {
                    const baseVersion = resolveOptionalBaseVersion(next)
                    upsertItems.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: next,
                        meta
                    } as any)
                    continue
                }

                const baseVersion = baseVersionByDeletedId.get(id)
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] restore/replace delete requires baseVersion (id=${String(id)})`)
                }
                deleteItems.push({ entityId: id, baseVersion, meta } as any)
            }

            const sideEffects = await runWriteJobs<T>({
                handle: args.handle as any,
                jobs: [
                    { action: 'upsert', items: upsertItems, options: { merge: false, upsert: { mode: 'loose' } } },
                    { action: 'delete', items: deleteItems }
                ],
                context: args.observabilityContext
            })
            return sideEffects.writeback ? { writeback: sideEffects.writeback } : undefined
        }

        const createItems: WriteItem[] = []
        const createServerAssignedItems: WriteItem[] = []
        const updateItems: WriteItem[] = []
        const deleteItems: WriteItem[] = []
        const upsertByOptions = new Map<string, { options?: WriteOptions; items: WriteItem[] }>()

        for (let idx = 0; idx < types.length; idx++) {
            const type = types[idx]
            const value = args.plan.appliedData[idx]
            if (!type || !value) continue
            if (type === 'hydrate' || type === 'hydrateMany') continue

            const meta = writeItemMetaForIndex({ operations: args.operations, idx, fallbackClientTimeMs })

            if (type === 'add') {
                const id = (value as any)?.id
                if (!isEntityId(id)) continue
                createItems.push({ entityId: id, value, meta } as any)
                continue
            }

            if (type === 'create') {
                createServerAssignedItems.push({ value, meta } as any)
                continue
            }

            if (type === 'update' || type === 'remove') {
                const id = (value as any)?.id
                if (!isEntityId(id)) continue
                updateItems.push({ entityId: id, baseVersion: requireBaseVersion(id, value), value, meta } as any)
                continue
            }

            if (type === 'forceRemove') {
                const id = (value as any)?.id
                if (!isEntityId(id)) continue
                deleteItems.push({ entityId: id, baseVersion: requireBaseVersion(id, value), meta } as any)
                continue
            }

            if (type === 'upsert') {
                const id = (value as any)?.id
                if (!isEntityId(id)) continue
                const baseVersion = resolveOptionalBaseVersion(value)

                const op = args.operations[idx]
                const options = upsertWriteOptions(op)
                const key = optionsKey(options)

                const entry = upsertByOptions.get(key) ?? (() => {
                    const next = { options, items: [] as WriteItem[] }
                    upsertByOptions.set(key, next)
                    return next
                })()

                entry.items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value,
                    meta
                } as any)
                continue
            }
        }

        const jobs: WriteJob[] = []
        if (createItems.length) jobs.push({ action: 'create', items: createItems, intent: 'created', requireCreatedData: false })
        if (createServerAssignedItems.length) jobs.push({ action: 'create', items: createServerAssignedItems, intent: 'created', requireCreatedData: true })
        for (const entry of upsertByOptions.values()) {
            jobs.push({ action: 'upsert', items: entry.items, ...(entry.options ? { options: entry.options } : {}) })
        }
        if (updateItems.length) jobs.push({ action: 'update', items: updateItems })
        if (deleteItems.length) jobs.push({ action: 'delete', items: deleteItems })

        const sideEffects = await runWriteJobs<T>({
            handle: args.handle as any,
            jobs,
            context: args.observabilityContext
        })

        return (sideEffects.created || sideEffects.writeback)
            ? ({
                ...(sideEffects.created ? { created: sideEffects.created } : {}),
                ...(sideEffects.writeback ? { writeback: sideEffects.writeback } : {})
            } as any)
            : undefined
    }
}
