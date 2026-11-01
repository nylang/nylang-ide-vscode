#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { ConfigDocumentSynchronization } = require("../configSynchronization");

async function main() {
  const listeners = new Map();
  const workspace = { textDocuments: [] };
  for (const event of ["Open", "Change", "Save", "Close"]) {
    workspace[`onDid${event}TextDocument`] = listener => {
      listeners.set(event, listener);
      return { dispose() { listeners.delete(event); } };
    };
  }
  const messages = [];
  const document = { uri: { scheme: "file", fsPath: "/source/lint.yaml", toString: () => "file:///source/lint.yaml" },
    languageId: "yaml", version: 1, text: "rules: {}", getText() { return this.text; } };
  workspace.textDocuments.push(document);
  const owner = new ConfigDocumentSynchronization({ workspace }, {
    async sendNotification(method, params) { messages.push({ method, params }); },
  }, () => true, message => { throw new Error(message); });
  owner.ready();
  await owner.pending;
  assert.strictEqual(messages[0].method, "textDocument/didOpen");
  document.text = "unsaved configuration";
  document.version = 2;
  listeners.get("Change")({ document, contentChanges: [{ text: document.text }] });
  await owner.pending;
  assert.deepStrictEqual(messages[1].params.contentChanges, [{ text: document.text }]);
  assert.strictEqual(messages[1].params.textDocument.version, 2);
  listeners.get("Save")(document);
  await owner.pending;
  assert.strictEqual(messages[2].method, "textDocument/didSave");
  // Disconnect invalidates queued work and replay uses the current editor version.
  listeners.get("Change")({ document, contentChanges: [{ text: document.text }] });
  owner.suspend();
  document.version = 3;
  owner.ready();
  await owner.pending;
  assert.strictEqual(messages.length, 4);
  assert.strictEqual(messages[3].method, "textDocument/didOpen");
  assert.strictEqual(messages[3].params.textDocument.version, 3);
  assert.strictEqual(owner.eligible({ ...document, languageId: "nyra" }), false);
  listeners.get("Close")(document);
  await owner.pending;
  assert.strictEqual(messages[4].method, "textDocument/didClose");
  owner.dispose();
  assert.strictEqual(listeners.size, 0);
  assert.strictEqual(owner.opened.size, 0);
  console.log("config synchronization: passed (open/edit/save/close, epoch retirement, restart replay, disposal)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
