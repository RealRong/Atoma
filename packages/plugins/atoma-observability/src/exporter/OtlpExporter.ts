import PQueue from 'p-queue'
import pRetry from 'p-retry'
import type { EventExporter, ExportEvent } from './types'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_RETRIES = 2
const DEFAULT_CONCURRENCY = 1
const DEFAULT_BATCH_SIZE = 20

export type OtlpExporterOptions = Readonly<{
    endpoint: string
    headers?: Record<string, string>
    timeoutMs?: number
    retries?: number
    concurrency?: number
    batchSize?: number
}>

export class OtlpExporter implements EventExporter {
    private readonly endpoint: string
    private readonly headers: Record<string, string>
    private readonly timeoutMs: number
    private readonly retries: number
    private readonly batchSize: number
    private readonly queue: PQueue
    private readonly buffer: ExportEvent[] = []

    constructor(options: OtlpExporterOptions) {
        this.endpoint = options.endpoint
        this.headers = options.headers ? { ...options.headers } : {}
        this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
        this.retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES))
        this.batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE))
        this.queue = new PQueue({
            concurrency: Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
        })
    }

    publish(entry: ExportEvent): void {
        this.buffer.push(entry)
        if (this.buffer.length < this.batchSize) return
        this.enqueueBatch(this.drainBatch())
    }

    async flush(): Promise<void> {
        while (this.buffer.length > 0) {
            this.enqueueBatch(this.drainBatch())
        }
        await this.queue.onIdle()
    }

    async dispose(): Promise<void> {
        await this.flush()
        this.queue.clear()
    }

    private drainBatch(): ExportEvent[] {
        return this.buffer.splice(0, this.batchSize)
    }

    private enqueueBatch(batch: ExportEvent[]) {
        if (batch.length === 0) return
        void this.queue.add(() => this.sendWithRetry(batch)).catch(() => {
            // ignore
        })
    }

    private async sendWithRetry(batch: ExportEvent[]): Promise<void> {
        await pRetry(async () => {
            await this.sendBatch(batch)
        }, {
            retries: this.retries
        })
    }

    private async sendBatch(batch: ExportEvent[]): Promise<void> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...this.headers
                },
                body: JSON.stringify({
                    schemaVersion: 1,
                    source: 'atoma-observability',
                    batch
                }),
                signal: controller.signal
            })

            if (response.ok) return

            throw new Error(`otlp exporter failed with status ${response.status}`)
        } finally {
            clearTimeout(timeout)
        }
    }
}
