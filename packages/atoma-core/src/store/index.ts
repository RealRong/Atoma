export {
    merge,
    putMany,
    deleteMany,
    reuse,
    upsertMany
} from './mutation'
export { applyChanges, upsertChanges, replaceChanges } from './state'
export { writeback } from './writeback'
export { toChange, invertChanges, revertChanges, mergeChanges } from './changes'
