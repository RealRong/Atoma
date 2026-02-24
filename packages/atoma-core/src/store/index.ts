export {
    merge,
    putMany,
    deleteMany,
    reuse,
    upsertMany
} from './mutation'
export { apply, upsert, replace } from './state'
export { writeback } from './writeback'
export { toChange, invertChanges, revertChanges, mergeChanges } from './changes'
