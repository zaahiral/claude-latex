// The state this mod keeps for the session. `version` goes up each time a
// LaTeX compile finishes, which redraws every message that read it.
export type CompileVersion = number

declare module 'claude-code' {
  interface PluginState {
    latex: { version: CompileVersion }
  }
}
