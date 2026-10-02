#!/bin/sh
# Rebuilds hooks/mathjax/ from MathJax 3.2.2 with Bun.
# A mod may not import a file over 1 MiB, so the bundle is split into chunks:
# the SVG font tables and the TeX font metrics become chunks of their own.
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund
F=node_modules/mathjax-full/js/output
rm -rf out
bun build entry.ts $F/svg/fonts/tex/normal.js $F/svg/fonts/tex/bold.js $F/common/fonts/tex/normal.js \
  node_modules/mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js node_modules/mathjax-full/js/input/tex/physics/PhysicsConfiguration.js \
  --splitting --format esm --target browser --minify --outdir out
rm -rf ../hooks/mathjax/*.js
cp out/entry*.js ../hooks/mathjax/
cp node_modules/mathjax-full/LICENSE ../hooks/mathjax/LICENSE
ls -l ../hooks/mathjax
