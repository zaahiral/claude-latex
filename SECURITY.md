# Security

## What the mod runs

The mod draws math with MathJax, which runs inside Claude Code with no file, process or network access.

LaTeX blocks are different. When a reply contains a ` ```tikz `, ` ```tikzcd ` or ` ```latex ` block, the mod compiles it with your own `latex` and `dvisvgm`. Claude writes those blocks, and Claude's replies can be shaped by whatever it reads: a web page, a file in your repository, an issue comment. So the mod treats every block as untrusted input.

## What protects you

| Risk | Protection |
| --- | --- |
| Running shell commands with `\write18` | `latex` runs with `-no-shell-escape` |
| Reading your files with `\input`, `\openin` or `\includegraphics` | On macOS, `sandbox-exec` denies reading your home folder apart from `~/.cache/claude-latex`, `~/Library/texlive`, `~/Library/texmf` and `~/texmf`, and denies `/Volumes` |
| Writing files with `\openout` | The sandbox denies writes outside the mod's cache, TeX's own folders and the temp folders. `openout_any=p` also stops TeX writing outside the build folder |
| Sending data out | The sandbox denies all network access |
| A block that never finishes | Each compile is stopped after 60 seconds |
| A block that exhausts TeX's memory | TeX stops with a capacity error, shown on that block |
| A huge drawing | A drawing over the app's 128 KB limit shows an error on that block, and the rest of the message still renders |
| A formula that overflows MathJax | Errors and stack overflows are caught and the formula shows as red source |

The sandbox profile is written to `~/.cache/claude-latex/sandbox.sb` when a session starts, so you can read exactly what it allows. Every compile runs in its own folder under `~/.cache/claude-latex/build/`, deleted afterwards.

TeX's own `openin_any=p` setting does not stop LaTeX reading a file by its absolute path. That is why the mod uses the macOS sandbox instead of relying on TeX's settings.

## Limits

- The sandbox is macOS only. Windows is not supported for LaTeX blocks yet, and math does not need it.
- The sandbox allows reading system folders such as `/etc` and `/usr`, which TeX needs to run. These do not hold your personal files.
- If `sandbox-exec` cannot run, LaTeX blocks compile without it and the setup log says so. Turn off **Compile LaTeX blocks** in `/latex` if you do not want that.
- The mod itself runs with your permissions, like every Claude Code plugin. Read `hooks/register.tsx`, or run `claude plugin validate .` to list every call it makes.

## Tested attacks

These were run on macOS with TeX Live 2026, using the mod's own compile commands, environment and sandbox profile:

- `\input` of a canary file in the home folder: reported as not found.
- `\openout` to the home folder: refused.
- `\immediate\write18{touch ...}`: no file created.
- `\def\a{\a\a}\a`: TeX capacity error.
- 2,000 page breaks in one block: "Dimension too large" error.
- A 3,000 point plot (442 KB of SVG): stopped by the size guard.
- A recursive macro and 400 nested exponents in MathJax: red source.

## Reporting a problem

Please report security problems privately through GitHub's **Report a vulnerability** button on this repository's Security tab, not in a public issue. Include the block that caused it, your macOS version and your TeX distribution.
