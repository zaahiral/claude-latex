// The global `h` the shared drawing code compiles against, building the same
// plain-data tree the engine's elements build: { type, props, children }.
export type Node = { type: string; props: Record<string, unknown>; children: Child[] }
export type Child = Node | string | number

function flatten(children: unknown[]): Child[] {
  const out: Child[] = []
  for (const c of children) {
    if (Array.isArray(c)) out.push(...flatten(c))
    else if (c !== null && c !== undefined && c !== false && c !== true) out.push(c as Child)
  }
  return out
}

;(globalThis as Record<string, unknown>).h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({
  type,
  props: props ?? {},
  children: flatten(children),
})
;(globalThis as Record<string, unknown>).Fragment = 'Fragment'
