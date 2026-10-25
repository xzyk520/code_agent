import * as vscode from "vscode";

export interface LibrarySkill {
  name: string;
  description: string;
  path: string;
}

export interface LibraryMcp {
  name: string;
  command: string;
  args: string[];
}

export interface LibraryState {
  skills: LibrarySkill[];
  mcp: LibraryMcp[];
}

export interface LibraryHandlers {
  addSkillFolder(): Promise<void>;
  addSkillFiles(files: Array<{ path: string; data: string }>): Promise<void>;
  addMcpFile(files: Array<{ name: string; text: string }>): Promise<void>;
  addUris(uris: string[]): Promise<void>;
  removeSkill(name: string): Promise<void>;
  removeMcp(name: string): Promise<void>;
  refresh(): Promise<void>;
}

/** Dedicated Skills & MCP view. Dropped files are read in the webview and sent as data. */
export class LibraryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "beeCode.libraryView";
  private view: vscode.WebviewView | undefined;
  private state: LibraryState = { skills: [], mcp: [] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: LibraryHandlers,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = this.html(view.webview, mediaRoot);
    view.webview.onDidReceiveMessage((raw) => void this.onMessage(raw));
    void this.handlers.refresh();
  }

  reveal(): void {
    if (this.view) this.view.show?.(true);
    else void vscode.commands.executeCommand(`${LibraryViewProvider.viewId}.focus`);
  }

  postState(state: LibraryState): void {
    this.state = state;
    this.post({ type: "state", state });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = (raw ?? {}) as { type?: string; name?: string; files?: unknown };
    switch (msg.type) {
      case "addSkillFolder":
        await this.handlers.addSkillFolder();
        return;
      case "addSkillFiles":
        await this.handlers.addSkillFiles(Array.isArray(msg.files) ? (msg.files as Array<{ path: string; data: string }>) : []);
        return;
      case "dropUris":
        await this.handlers.addUris(Array.isArray(msg.files) ? (msg.files as unknown as string[]) : []);
        return;
      case "addMcpFile":
        await this.handlers.addMcpFile(Array.isArray(msg.files) ? (msg.files as Array<{ name: string; text: string }>) : []);
        return;
      case "removeSkill":
        if (typeof msg.name === "string") await this.handlers.removeSkill(msg.name);
        return;
      case "removeMcp":
        if (typeof msg.name === "string") await this.handlers.removeMcp(msg.name);
        return;
      case "refresh":
        await this.handlers.refresh();
        return;
    }
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "library.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "library.js"));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}`;
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${style}" /></head>
<body>
  <header><h1>Skills &amp; MCP</h1><button id="refresh">Refresh</button></header>
  <section>
    <h2>Skills</h2>
    <p class="hint">Drop a skill folder or a SKILL.md file, or choose a folder. Installed in <code>.beecode/skills/</code>.</p>
    <div id="skill-drop" class="drop">Drop skill folder / SKILL.md here</div>
    <button id="add-skill">Choose skill folder…</button>
    <ul id="skills"></ul>
  </section>
  <section>
    <h2>MCP servers</h2>
    <p class="hint">Drop an <code>mcp.json</code> config. Installed in <code>.beecode/mcp.json</code>.</p>
    <div id="mcp-drop" class="drop">Drop mcp.json here</div>
    <button id="add-mcp">Choose mcp.json…</button>
    <ul id="mcp"></ul>
  </section>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}
