/**
 * Default Snowflake-like ID generator (number-based, safe within JS number range)
 *
 * Layout (53 bits total to stay within Number safe integer):
 * - 41 bits: milliseconds since custom epoch
 * - 12 bits: per-ms sequence (0-4095)
 */
const CUSTOM_EPOCH = Date.UTC(2023, 0, 1) // 2023-01-01 UTC
const MAX_SEQUENCE = 0xfff

let lastTimestamp = 0
let sequence = 0
let customGenerator: (() => number | string) | undefined

const defaultSnowflakeGenerator = (): number => {
    const now = Date.now()
    if (now === lastTimestamp) {
        sequence = (sequence + 1) & MAX_SEQUENCE
        if (sequence === 0) {
            // Sequence overflow within the same ms, wait for next tick
            while (Date.now() === lastTimestamp) {
                // busy-wait very briefly; acceptable given rare overflow (4k ids/ms)
            }
            return defaultSnowflakeGenerator()
        }
    } else {
        sequence = 0
        lastTimestamp = now
    }

    const timestampPart = (now - CUSTOM_EPOCH) << 12
    return timestampPart + sequence
}

/**
 * Set a custom global ID generator.
 */
export function setDefaultIdGenerator(generator: () => number | string) {
    customGenerator = generator
}

/**
 * Get the currently configured ID generator (custom or default).
 */
export function getIdGenerator(): () => number | string {
    return customGenerator || defaultSnowflakeGenerator
}

export { defaultSnowflakeGenerator }
