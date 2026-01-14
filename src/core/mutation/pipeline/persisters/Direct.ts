import type { ObservabilityContext } from '#observability'
import { Protocol, type EntityId, type Operation, type StandardError, type WriteAction, type WriteItem, type WriteOptions, type WriteResultData } from '#protocol'
import type { Entity, PersistWriteback } from '../../../types'
import type { Persister, PersisterPersistArgs, PersisterPersistResult } from '../types'
import { executeOps } from '../../../store/internals/opsExecutor'
import { translatePlanToWrites } from './writePlanTranslation'

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

// plan→write 翻译已统一到 writePlanTranslation

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
        ops.push(Protocol.ops.build.buildWriteOp({
            opId: args.handle.nextOpId('w'),
            write: {
                resource: args.handle.storeName,
                action: job.action,
                items: job.items,
                ...(job.options ? { options: job.options } : {})
            }
        }))
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
        const fallbackClientTimeMs = args.metadata.timestamp

        const translated = translatePlanToWrites({
            plan: args.plan,
            operations: args.operations,
            fallbackClientTimeMs,
            mode: 'direct'
        })

        const jobs: WriteJob[] = translated.map(w => ({
            action: w.action,
            items: w.items,
            ...(w.options ? { options: w.options } : {}),
            ...(w.intent ? { intent: w.intent } : {}),
            ...(typeof w.requireCreatedData === 'boolean' ? { requireCreatedData: w.requireCreatedData } : {})
        }))

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
