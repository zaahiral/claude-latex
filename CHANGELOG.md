# Changelog

## 0.5.0

- Your messages can render as Markdown with math, in a bubble. This is the experimental `rendered` value of the new **Your messages** setting. The app's own row stays under the bubble as a small pill, so the time, rewind and fork controls are kept. Your messages are now left as typed by default. `under` brings back the math under the app's bubble.
- The desktop app drops a drawing over about 250 KB and keeps showing an older one. The mod now measures its drawing, stops at 235 KB and hands the rest of the message to the app with a note.
- The parser reads a message left to right. This fixes `$a$$b$` swallowing the rest of a message, `$$` inside a code span drawn as math, a `$` inside `\text{}` splitting a formula, and an empty `$$ $$` turning prose into math.
- A table with math in its cells is laid out by the mod. Links, `_italic_`, `~~strikethrough~~` and `\$` work in a paragraph that has math.
- A display formula MathJax cannot draw, such as one with `\intertext`, is typeset by your TeX install.
- A macro defined in one formula no longer changes later formulas. Tags and labels start again for each formula.
- Array rules (`\hline`, the `|` in `{cc|c}`) and frames now draw. Their width was in a stylesheet that a standalone SVG does not have.
- Each MathJax SVG is about 40% smaller: glyph outlines are rewritten on a coarser grid in relative coordinates, and MathJax's page-only attributes are dropped. A page of about 75 formulas now fits in one reply.
- The model is told how math renders here: one section added to the system prompt, where the mod draws, with the syntax that renders and the size limits. The **Tell the model how math renders here** setting turns it off.
- A block that is compiling is no longer compiled again by a second and third worker.
- Punctuation stays on the same line as the formula it touches. Nested lists step in, a list with math in it is laid out as one list, and a list that reaches 10 no longer has its numbers clipped.
- Blank lines at the start and end of a block are dropped. A pasted `tikzcd` block that ended with one failed to compile.
- The debug log records every message drawn, its size, each compile and any reason the engine gives for refusing a drawing.

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
