# Changelog

## 0.4.0

- Your own messages keep the app's bubble, with its copy button. The math and diagrams from your message are drawn under it. A full rendered copy is an option, off by default.
- A one-time welcome note above the prompt, and a settings pane opened with `/latex`.
- Every `latex` and `dvisvgm` run goes through a macOS sandbox that blocks reading your home folder, writing elsewhere and the network.
- MathJax SVGs define each glyph once, so long formulas are about 70% smaller and fit the app's limit.
- Setup runs in the background after a session starts, one step at a time, and writes `~/.cache/claude-latex/debug/setup.log`.
- Messages are not force-redrawn while a reply streams. This fixes a reply that could stop drawing partway.
- More preamble-only commands (`\DeclareMathAlphabet`, `\newtheorem`, `\definecolor` and others) are moved out of block bodies.
- The Copy TeX button is a setting, off by default.
- Interrupted compiles are retried. A compile that runs past 60 seconds says it may loop forever.

## 0.3.0

- Ten LaTeX math fonts, typeset by your own TeX install, with MathJax shown until each formula is ready.
- ` ```latex ` blocks for any LaTeX snippet.
- mhchem and physics in MathJax, `\bm`, and unknown commands reported as errors.
- Saved LaTeX formats, which roughly halve compile time, and three compiles at once.
- Each compile runs in its own folder.
- Drawings over the app's 128 KB limit show an error on that block.

## 0.2.0

- TikZ and tikz-cd blocks, compiled with `latex` and `dvisvgm`.
- Inline math sits on the text's baseline.
- A macros file, light and dark settings, and math in your own messages.

## 0.1.0

- First release: MathJax renders `$...$` and `$$...$$` in Claude's replies in the desktop Code tab.
