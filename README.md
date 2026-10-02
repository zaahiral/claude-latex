<p align="center">
  <img src="assets/banner.gif" width="800" alt="A pixel-art study. Clawd stands by a chalkboard of typeset equations and says: My math renders now!">
</p>

<h1 align="center">LaTeX for Claude Code</h1>

<p align="center">
  Renders TeX math, TikZ diagrams and LaTeX blocks in Claude's replies, in the Claude Code desktop app.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Claude Code 2.1.287 or later" src="https://img.shields.io/badge/Claude%20Code-2.1.287%2B-555">
  <img alt="Desktop app, Code tab" src="https://img.shields.io/badge/runs%20in-desktop%20Code%20tab-555">
</p>

Without this mod, Claude's replies show math as raw source, such as `$\frac{\partial L}{\partial w}$`. With it, the same reply shows typeset math. With a TeX install, it also compiles diagrams, circuits, chess positions and whole LaTeX snippets right in the chat.

<p align="center">
  <img src="assets/demo-math.png" width="720" alt="Colored inline math, every math alphabet, colored boxes and a nested continued fraction, rendered in a Claude Code reply">
</p>

## Install

```sh
claude plugin marketplace add zaahiral/claude-latex
claude plugin install latex@claude-latex
```

Then restart the desktop app, or run `/reload-plugins` in an open session. A short welcome note appears above the prompt the first time. Run `/latex` at any time to open the settings.

Requirements:

- **Claude Code 2.1.287 or later**, the first release with mods.
- **The Code tab of the Claude desktop app.** Mods do not draw in a terminal or in the VS Code extension. See [Where it works](#where-it-works).
- **Optional: a TeX install** with `latex` and `dvisvgm`, such as [MacTeX](https://www.tug.org/mactex/) or TeX Live. You need it for diagrams, LaTeX blocks and the extra fonts. Math works without it.

## What it renders

| In a reply | You see |
| --- | --- |
| `$...$` or `\(...\)` | Inline math, sitting on the text's baseline |
| `$$...$$`, `\[...\]`, `equation`, `align`, `gather`, `multline` | Centered display math |
| A ` ```tikz ` or ` ```tikzcd ` code block | A diagram, compiled by your TeX install |
| A ` ```latex ` code block | Any LaTeX snippet: chemfig, quantikz, circuitikz, forest, chessboard, amsthm, tables |

<p align="center">
  <img src="assets/demo-diagrams.png" width="800" alt="A snake lemma, a chess position, a Feynman diagram, a phase portrait, a polar rose and a 3D sphere, all rendered in Claude Code replies">
</p>

The two example images above are screenshots of the mod running in the Code tab.

MathJax draws the math. It knows AMS environments, `mathtools`, chemistry with `\ce` (mhchem), `\dv` and `\qty` (physics), `\bra` and `\ket` (braket), `\cancel` and `\color`. `\bm` works as `\boldsymbol`.

Dollar amounts are left alone. `$5 and $10` stays as text, because an opening `$` followed by a space, or a closing `$` followed by a digit, does not start math. Math inside code is left as code. A formula MathJax cannot parse shows as red source, and the rest of the message still renders.

### Your own messages

Your own messages are left as typed. Two settings change that.

Set **Your messages** to `under` to keep the app's bubble and show the math and diagrams from your message under it, rendered, so you can check what you typed.

Set it to `rendered` to draw the whole message as Markdown with its math, the way AI Studio shows a sent message. This is experimental. A mod cannot draw inside the app's bubble, so the mod draws a bubble of its own with a Copy button. The app's own row stays under it as a small "⋯" pill, because the time, rewind and fork controls belong to that row. A message with nothing to render keeps the app's bubble.

## Fonts

<p align="center">
  <img src="assets/fonts.png" width="720" alt="The same formula typeset in ten fonts">
</p>

MathJax has one font, Computer Modern, and draws at once. Set **Math font** to one of `cm`, `libertinus`, `palatino`, `times`, `euler`, `concrete`, `fourier`, `stix2`, `kpfonts` or `cmbright`, and your own LaTeX typesets every formula in that font. MathJax shows each formula until the LaTeX version is ready, usually within a second. All formulas in a message compile in one run, and results are cached in `~/.cache/claude-latex/`. Diagrams and LaTeX blocks use the same font.

## Settings

Run `/latex` to open the settings pane. Each change applies at once.

| Setting | Default | What it does |
| --- | --- | --- |
| Math font | `mathjax` | MathJax, or one of 10 LaTeX fonts typeset by your TeX install |
| Math color | `auto` | `auto` follows your system's light or dark setting. Pick `light` or `dark` if the app's theme differs |
| Compile LaTeX blocks | on | Compile ` ```tikz `, ` ```tikzcd ` and ` ```latex ` blocks |
| Your messages | `off` | `off` leaves your messages as typed. `under` shows the math from your message under the app's bubble. `rendered` (experimental) draws the message as Markdown with math in its own bubble |
| Tell the model how math renders here | on | Adds a short note to the system prompt: the syntax that renders, what a code block compiles, and the size limits of one reply |
| Copy TeX button | off | A button under each display formula and block that copies its source |
| Macros file | `~/.claude/latex-macros.tex` | Your own `\newcommand` and `\DeclareMathOperator` lines |

### Macros

Put definitions in `~/.claude/latex-macros.tex`:

```tex
\newcommand{\E}{\mathbb{E}}
\newcommand{\R}{\mathbb{R}}
\DeclareMathOperator*{\argmin}{arg\,min}
```

`$\E[X]$` and `$\argmin_\theta L(\theta)$` then work in every message, in MathJax and in LaTeX.

### LaTeX blocks

A ` ```tikz ` block holds the inside of a `tikzpicture`. A ` ```tikzcd ` block holds the inside of a `tikzcd`. A ` ```latex ` block holds a document body up to 15 cm wide. Lines at the top of a block that start with `\usepackage`, `\usetikzlibrary`, `\pgfplotsset`, `\tikzset`, `\newcommand`, `\DeclareMathOperator`, `\DeclareMathAlphabet`, `\newtheorem`, `\definecolor` and similar go into the preamble.

````md
```latex
\usepackage{chemfig}
\chemfig{*6((-OH)=-=(-COOH)-=-)}
```
````

Every block loads `amsmath`, `bm`, `mathtools`, `xcolor`, `cancel`, `braket` and `mhchem`. TikZ blocks also load `tikz-cd`, `pgfplots` and the common TikZ libraries. Black ink follows your theme. Other colors stay as written.

## Speed

A diagram takes 0.4 to 0.7 seconds to compile the first time and is instant after that. Three compiles run at once. Each kind of document compiles against a saved LaTeX format that already holds its preamble, which roughly halves LaTeX's time. Formats build once, in the background.

## Security

Claude writes the LaTeX blocks, so a reply could try to make LaTeX read or write your files. The mod treats every block as untrusted:

- Shell escape is off (`-no-shell-escape`).
- Every `latex` and `dvisvgm` run goes through macOS's `sandbox-exec`. The sandbox blocks reading your home folder apart from TeX's own folders and the mod's cache, blocks writing anywhere else, and blocks the network.
- TeX's own `openout_any=p` blocks writing outside the build folder.
- A compile is stopped after 60 seconds.
- A drawing over the app's 128 KB limit shows an error on that block instead of breaking the message.

Details and how to report a problem are in [SECURITY.md](SECURITY.md).

## What it does on your machine

This is everything the mod runs, reads, writes and changes.

- **Programs it runs.** `latex` and `dvisvgm` from your TeX install, to compile LaTeX blocks and the LaTeX fonts. Every one of those runs goes through `/usr/bin/sandbox-exec`. `/usr/bin/true` runs once per session to check that the sandbox works. `/usr/bin/find`, `/bin/rm` and `/bin/mv` clear old build folders and move a finished LaTeX format into place. Without a TeX install the mod runs nothing.
- **Environment variables it reads.** `HOME`, to find the cache folder and your macros file. `PATH`, to find `latex` and `dvisvgm`. It sets none.
- **Files it reads.** Your macros file, and its own cache. It checks whether `latex` and `dvisvgm` exist in the folders listed under [Troubleshooting](#troubleshooting).
- **Files it writes.** Only inside `~/.cache/claude-latex/`: compiled SVGs, saved LaTeX formats, one build folder per compile (deleted afterwards), the sandbox profile `sandbox.sb` and the setup log `debug/setup.log`.
- **Settings it changes.** Only its own settings (`latex.mathFont`, `latex.colorScheme`, `latex.userBubble`, `latex.tellModel`, `latex.copyButton`, `latex.tikz`), and only when you change one in the `/latex` pane. It writes them through the app's own settings.
- **What it stores.** One value: whether you dismissed the welcome note.
- **The conversation.** It reads each message to draw it. Its `prompt.submit` hook only notes when a turn starts, so the mod does not redraw during a reply. It does not read or change your prompt. With **Tell the model how math renders here** on, it adds one short section to the system prompt. The text is `MODEL_NOTE` in `hooks/register.tsx`.
- **Network.** None. MathJax runs inside the mod, and the sandbox blocks the network for every LaTeX run. Nothing the mod reads leaves your machine.
- **The MathJax bundle.** `hooks/mathjax/` is minified. `build/build.sh` builds it from `mathjax-full` 3.2.2. `build/clean.mjs` then removes an unused `__proto__` fallback that TypeScript adds, and writes every character outside ASCII as a `\uXXXX` escape. MathJax's own classes use `Object.setPrototypeOf` and `Object.defineProperty`.

## Where it works

| Where | Renders |
| --- | --- |
| Code tab of the Claude desktop app, macOS | Yes |
| Code tab on Windows | Math yes. LaTeX blocks are not supported yet |
| Claude mobile app through Remote Control | Should work, not tested |
| `claude` in a terminal | No. Terminals cannot draw SVG |
| VS Code extension, `claude -p` | No. Mods do not draw there |

## Troubleshooting

- **LaTeX blocks stay as code.** The mod did not find `latex` and `dvisvgm`. It looks in `/Library/TeX/texbin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and your `PATH`.
- **Something else looks wrong.** Each session writes a setup log to `~/.cache/claude-latex/debug/setup.log`, with every setup step, how long it took, and any drawing error. Attach it to a bug report.

## How it works

A mod is a plugin whose code runs inside Claude Code. This one hooks the drawing of each message (`ui.render` on `AssistantMessage` and `UserMessage`). When a message contains math, it splits the text into pieces. Prose goes back to the app's own Markdown renderer. Display math becomes an SVG from [MathJax 3](https://www.mathjax.org/), which runs inside the mod with no network access. A paragraph with inline math is laid out word by word, with each formula padded so its baseline lines up with the text. LaTeX blocks are queued, compiled in the background with `latex` and `dvisvgm`, and drawn when ready.

The MathJax bundle is in `hooks/mathjax/`, split into chunks because a mod cannot import a file over 1 MiB. `build/build.sh` rebuilds it from `mathjax-full` 3.2.2, so you can check it against the published source.

To list everything the mod hooks and calls before you install it:

```sh
claude plugin validate .
```

## Known limits

- A very long inline formula is scaled down to fit the line.
- The desktop app drops a message's drawing once it passes about 250 KB, and says nothing. The mod stops at 235 KB, which is roughly 75 formulas in a reply that is mostly text, or 4 to 6 diagrams, and hands the rest of that reply to the app with a one-line note.
- A table with math in it is laid out by the mod, with plain columns and no borders. A table without math keeps the app's own rendering.
- A formula defined with `\newcommand` inside one formula does not reach the next. Put shared macros in the macros file.
- A mod cannot draw inside the app's bubble for your own message, and cannot rewind or fork. The `rendered` setting works around this with a bubble of its own and the app's row kept under it.

## Develop

```sh
git clone https://github.com/zaahiral/claude-latex
claude --plugin-dir ./claude-latex
claude plugin test ./claude-latex
```

The tests need Claude Code 2.1.286 or later. They fake `latex` and `dvisvgm`, so they run without a TeX install.

## License

MIT. MathJax is Apache 2.0, and its license is in `hooks/mathjax/LICENSE`.

This is a community plugin. It is not made or endorsed by Anthropic. Clawd is Anthropic's Claude Code mascot.
