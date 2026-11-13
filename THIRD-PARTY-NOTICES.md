# Third-party notices

`vendor/` contains unmodified browser builds of the following packages. They are
served to the panel by this plugin's own route, so they ship inside the package
rather than being installed at runtime.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `xterm.js` | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| `xterm.css` | [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) | 6.0.0 | MIT |
| `addon-fit.js` | [`@xterm/addon-fit`](https://github.com/xtermjs/xterm.js) | 0.11.0 | MIT |

## MIT license text (as used by xterm.js)

```
Copyright (c) 2014-2025 The xterm.js authors
Copyright (c) 2012-2015 Christopher Jeffrey

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The Host half additionally resolves `@xterm/headless` and
`@xterm/addon-serialize` from the DeepSeek Harness installation at runtime. They
are not redistributed here; they come with the host that provides them.
