import type { ActionContext, ActionOrigin } from '../../core'

export type ActionEngine = Readonly<{
    createContext: (
        context?: Partial<ActionContext>,
        options?: { defaultScope?: string; defaultOrigin?: ActionOrigin }
    ) => ActionContext
}>
