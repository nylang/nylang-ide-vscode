"use strict";

/** Own file-backed YAML editor overlays for one native analyzer connection.
 * Language-client selectors remain Nyra-only: YAML gets no Nyra query providers.
 * Restart replays current buffers, and disposal retires listeners and queued work.
 */
class ConfigDocumentSynchronization {
  constructor(vscode, client, isCurrent, log) {
    this.vscode = vscode;
    this.client = client;
    this.isCurrent = isCurrent;
    this.log = log;
    this.opened = new Set();
    this.listeners = [];
    this.active = false;
    this.epoch = 0;
    this.pending = Promise.resolve();
    const workspace = vscode.workspace;
    if (workspace.onDidOpenTextDocument) {
      this.listeners.push(workspace.onDidOpenTextDocument(document => this.open(document)));
      this.listeners.push(workspace.onDidChangeTextDocument(event => {
        if (!this.eligible(event.document) || !event.contentChanges.length) return;
        const uri = event.document.uri.toString();
        if (!this.opened.has(uri)) { this.open(event.document); return; }
        this.send("textDocument/didChange", { textDocument: { uri, version: event.document.version },
          contentChanges: [{ text: event.document.getText() }] });
      }));
      this.listeners.push(workspace.onDidSaveTextDocument(document => {
        if (this.opened.has(document.uri.toString())) {
          this.send("textDocument/didSave", { textDocument: { uri: document.uri.toString() } });
        }
      }));
      this.listeners.push(workspace.onDidCloseTextDocument(document => {
        const uri = document.uri.toString();
        if (this.opened.delete(uri)) this.send("textDocument/didClose", { textDocument: { uri } });
      }));
    }
  }

  eligible(document) {
    return document.uri.scheme === "file" && document.languageId !== "nyra" && /\.ya?ml$/i.test(document.uri.fsPath);
  }

  send(method, params) {
    if (!this.active) return;
    const epoch = this.epoch;
    this.pending = this.pending.then(async () => {
      if (!this.active || epoch !== this.epoch || !this.isCurrent()) return;
      try { await this.client.sendNotification(method, params); }
      catch (error) { this.log(`Analyzer config synchronization failed: ${error.message || error}`); }
    });
  }

  open(document) {
    const uri = document.uri.toString();
    if (!this.active || !this.eligible(document) || this.opened.has(uri)) return;
    this.opened.add(uri);
    this.send("textDocument/didOpen", { textDocument: {
      uri, languageId: document.languageId, version: document.version, text: document.getText(),
    } });
  }

  ready() {
    this.epoch += 1;
    this.opened.clear();
    this.active = true;
    for (const document of this.vscode.workspace.textDocuments || []) this.open(document);
  }

  suspend() {
    this.active = false;
    this.epoch += 1;
    this.opened.clear();
  }

  dispose() {
    this.suspend();
    for (const listener of this.listeners) listener.dispose();
    this.listeners = [];
  }
}

module.exports = { ConfigDocumentSynchronization };
