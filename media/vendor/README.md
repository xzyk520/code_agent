# Vendored 前端依赖

## Mermaid

- Package: `mermaid@12.2.0`
- File: `mermaid.min.js`
- License: MIT（https://github.com/mermaid-js/mermaid/blob/develop/LICENSE）
- 用途：面板按需渲染 `diagram` 工具生成的 Mermaid 源码
- 加载方式：`media/panel.js` 在出现第一张图时动态插入 `<script>`，不在首屏加载

更新方式：

```bash
npm install --save-dev mermaid@<version>
copy node_modules/mermaid/dist/mermaid.min.js media/vendor/mermaid.min.js
```

## highlight.js

- Package: `highlight.js@11.11.1`（cdnjs 全量 bundle）
- File: `highlight.min.js`
- License: BSD-3-Clause（见 `LICENSE-highlight.txt`）
- 用途：Markdown 代码块的语法高亮（Python/C++/JS/TS/JSON/Bash 等）
- 加载方式：面板 HTML 里用 nonce `<script>` 同步加载；CSP 只允许 nonce 脚本
- 样式：不引入 highlight.js 主题，token 颜色在 `media/panel.css` 里映射到 VS Code 主题变量

更新方式：

```bash
curl -L -o media/vendor/highlight.min.js \
  https://cdnjs.cloudflare.com/ajax/libs/highlight.js/<version>/highlight.min.js
```
