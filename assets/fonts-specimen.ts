import { FONTS } from '../hooks/texjobs.ts'
import { writeFileSync } from 'fs'
const names: Record<string,string> = { cm: 'Computer Modern', libertinus: 'Libertinus', palatino: 'Palatino (newpx)', times: 'Times (newtx)', euler: 'AMS Euler', concrete: 'Concrete + Euler', fourier: 'Fourier (Utopia)', stix2: 'STIX Two', kpfonts: 'Kp Fonts', cmbright: 'CM Bright' }
let i = 0
for (const [k, pre] of Object.entries(FONTS)) {
  writeFileSync(`f${i++}.tex`, `\\documentclass[border=6pt]{standalone}
\\usepackage{amsmath}
${pre}
\\usepackage{bm,xcolor,graphicx}
\\begin{document}
\\scalebox{3}{\\begin{minipage}{13cm}
\\makebox[3.6cm][l]{\\textcolor{gray}{\\small\\texttt{${k}}}}%
$\\displaystyle \\mathbb{E}_{x\\sim p}\\!\\left[\\log \\frac{p(x)}{q_{\\bm\\theta}(x)}\\right] = \\int p(x)\\log\\frac{p(x)}{q_{\\bm\\theta}(x)}\\,dx \\geq 0$
\\end{minipage}}
\\end{document}
`)
}
