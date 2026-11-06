#!/usr/bin/env python3
"""Inline CSS, DSP, worklet and app JS into one self-contained HTML file."""
import json, pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'index.html').read_text()
html = html.replace('/*CSS*/', (src / 'style.css').read_text())
html = html.replace('/*DSP*/', (src / 'dsp.js').read_text())
html = html.replace('/*WORKLET*/', json.dumps((src / 'worklet.js').read_text()))
html = html.replace('/*APP*/', (src / 'app.js').read_text())
assert '</script>' not in (src / 'dsp.js').read_text() + (src / 'app.js').read_text()
out = root / 'dist' / 'TimeAlign.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print(out, len(html), 'bytes')
