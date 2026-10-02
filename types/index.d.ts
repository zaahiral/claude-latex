// The state this mod keeps for the session. `version` goes up each time a
// LaTeX compile finishes, which redraws every message that read it.
export type CompileVersion = number
// Whether the one-time welcome band shows above the prompt.
export type IntroVisible = boolean

declare module 'claude-code' {
  interface PluginState {
    latex: { version: CompileVersion; intro: IntroVisible }
  }
}
