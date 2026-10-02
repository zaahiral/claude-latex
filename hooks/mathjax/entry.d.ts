// Typesets one formula. Macros it defines do not outlive it.
export function tex2svg(tex: string, display: boolean): string
// Typesets `tex` and keeps the macros it defines for every later formula.
export function definePreamble(tex: string): string
