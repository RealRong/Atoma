import pino, { type Logger, type LoggerOptions } from 'pino'
import type { EventExporter, ExportEvent } from './types'

export type PinoExporterOptions = Readonly<{
    logger?: Logger
    level?: LoggerOptions['level']
    name?: string
}>

export class PinoExporter implements EventExporter {
    private readonly logger: Logger

    constructor(options: PinoExporterOptions = {}) {
        this.logger = options.logger ?? pino({
            name: options.name ?? 'atoma-observability',
            level: options.level ?? 'info'
        })
    }

    publish(entry: ExportEvent): void {
        this.logger.info({
            storeName: entry.storeName,
            event: entry.event
        }, 'atoma observability event')
    }
}
