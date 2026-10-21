# Vendored Mermaid

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
