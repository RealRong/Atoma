import { zod } from '#shared'

const { z } = zod

export const nonEmptyString = () => z.string().trim().min(1)

export const anyFunction = () =>
    z.custom<(...args: any[]) => any>(value => typeof value === 'function')
