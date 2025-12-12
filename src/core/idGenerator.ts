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
    const now = BigInt(Date.now())

    if (Number(now) === lastTimestamp) {
        sequence = (sequence + 1) & MAX_SEQUENCE
        if (sequence === 0) {
            // 序列溢出，等下一毫秒
            while (BigInt(Date.now()) === now) { /* spin very briefly */ }
            return defaultSnowflakeGenerator()
        }
    } else {
        sequence = 0
        lastTimestamp = Number(now)
    }

    // 41bit 时间戳 + 12bit 序列
    const id = ((now - BigInt(CUSTOM_EPOCH)) << 12n) | BigInt(sequence)
    const asNumber = Number(id)
    if (!Number.isSafeInteger(asNumber)) {
        throw new Error('Generated id exceeds Number safe integer range')
    }
    return asNumber
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
