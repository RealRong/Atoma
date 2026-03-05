import type { ReactNode } from 'react'

export function Pill(props: { children: ReactNode }) {
    return (
        <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[11px] font-medium text-slate-700">
            {props.children}
        </span>
    )
}
