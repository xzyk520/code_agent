/**
 * Webview 全局声明：`acquireVsCodeApi` 由 VS Code 在 webview 里注入，
 * 不在 DOM 标准库中，所以需要自己声明。
 * 文档：https://code.visualstudio.com/api/extension-guides/webview#scripts-and-message-passing
 */
interface VsCodeWebviewApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;
