import * as vscode from "vscode";

/**
 * Read-only pseudo-terminal that mirrors commands executed by the agent and their output.
 * It deliberately does not run a shell: executing here would bypass the policy/approval layer.
 */
export class CommandTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private terminal: vscode.Terminal | undefined;

  open(): void {
    /* The terminal is ready; command output is written on demand. */
  }

  close(): void {
    this.terminal = undefined;
  }

  show(): void {
    if (!this.terminal) {
      this.terminal = vscode.window.createTerminal({ name: "Bee Code Commands", pty: this });
    }
    this.terminal.show(true);
  }

  writeLine(text = ""): void {
    this.writeEmitter.fire(`${text.replace(/\r?\n/g, "\r\n")}\r\n`);
  }

  writeResult(exitCode: number | null, stdout: string, stderr: string, elapsedMs: number): void {
    this.writeLine("");
    if (stderr.trim()) {
      this.writeLine("--- stderr ---");
      this.writeLine(stderr.trimEnd());
    }
    if (stdout.trim()) {
      this.writeLine("--- stdout ---");
      this.writeLine(stdout.trimEnd());
    }
    this.writeLine(`[exit ${exitCode ?? "?"} · ${Math.round(elapsedMs / 1000)}s]`);
    this.writeLine("");
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.terminal?.dispose();
  }
}