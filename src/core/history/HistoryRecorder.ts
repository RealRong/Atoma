import { Atom } from 'jotai'
import { Patch } from 'immer'
import { IAdapter } from '../types'

export type HistoryCallback = (
    patches: Patch[],
    inversePatches: Patch[],
    atom: Atom<any>,
    adapter: IAdapter<any>
) => void

/**
 * Centralizes history recording; records only on successful operations.
 */
export class HistoryRecorder {
    private callback?: HistoryCallback

    setCallback(callback: HistoryCallback) {
        this.callback = callback
    }

    record(params: { patches: Patch[], inversePatches: Patch[], atom: Atom<any>, adapter: IAdapter<any> }) {
        if (!this.callback) return
        const { patches, inversePatches, atom, adapter } = params
        this.callback(patches, inversePatches, atom, adapter)
    }
}
