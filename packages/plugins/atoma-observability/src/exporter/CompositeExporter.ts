import type { EventExporter, ExportEvent } from './types'

const runSafely = async (task: () => void | Promise<void>) => {
    try {
        await task()
    } catch {
        // ignore
    }
}

export class CompositeExporter implements EventExporter {
    private readonly exporters: EventExporter[]

    constructor(exporters: ReadonlyArray<EventExporter>) {
        this.exporters = [...exporters]
    }

    publish(entry: ExportEvent): void {
        this.exporters.forEach((exporter) => {
            try {
                const result = exporter.publish(entry)
                if (result && typeof (result as Promise<void>).then === 'function') {
                    void (result as Promise<void>).catch(() => {
                        // ignore
                    })
                }
            } catch {
                // ignore
            }
        })
    }

    async flush(): Promise<void> {
        for (const exporter of this.exporters) {
            if (typeof exporter.flush !== 'function') continue
            await runSafely(() => exporter.flush!())
        }
    }

    async dispose(): Promise<void> {
        await this.flush()

        for (let index = this.exporters.length - 1; index >= 0; index -= 1) {
            const exporter = this.exporters[index]
            if (typeof exporter.dispose !== 'function') continue
            await runSafely(() => exporter.dispose!())
        }
    }
}
