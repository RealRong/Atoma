export type TextOperator = 'and' | 'or'

export type MatchDefaults = {
    op?: TextOperator
    minTokenLength?: number
    tokenizer?: (text: string) => string[]
}

export type FuzzyDefaults = {
    op?: TextOperator
    distance?: 0 | 1 | 2
    minTokenLength?: number
    tokenizer?: (text: string) => string[]
}

export type FieldMatcherOptions = {
    match?: MatchDefaults
    fuzzy?: FuzzyDefaults
}

export type QueryMatcherOptions = {
    fields?: Record<string, FieldMatcherOptions>
}
