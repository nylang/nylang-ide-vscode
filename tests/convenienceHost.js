"use strict";

// Real extension consumption of native receiver facts; generated workspace and
// user profile belong to the root launcher's single owned task directory.
const assert = require("assert");
const fs = require("fs");
const vscode = require("vscode");

async function until(operation, accept, label) {
  const deadline = Date.now() + 30000;
  let value;
  while (Date.now() < deadline) {
    value = await operation();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Deadline waiting for ${label}: ${JSON.stringify(value)}`);
}

function position(document, needle, inside) {
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, needle);
  return document.positionAt(offset + inside);
}

exports.run = async function () {
  const checks = [];
  const extension = vscode.extensions.getExtension("nyra.nyra-lang");
  assert.ok(extension);
  await extension.activate();
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "main.ny");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  const original = document.getText();
  const completion = (needle, inside) => vscode.commands.executeCommand(
    "vscode.executeCompletionItemProvider", uri, position(document, needle, inside));
  for (const [needle, inside, wanted, excluded] of [
    ["item!.Read", "item!.Re".length, "Read", "Wrong"],
    ["item?.Read", "item?.Re".length, "Read", "Wrong"],
    ["builder..OtherValue()..Read", "builder..OtherValue()..Re".length, "Read", "Wrong"],
    ["item?.OtherValue()?.Wrong", "item?.OtherValue()?.Wro".length, "Wrong", "Read"],
    ["item?.AliasValue()?.Wrong", "item?.AliasValue()?.Wro".length, "Wrong", "Read"],
    ["    item.Read", "    item.Re".length, "Read", "Wrong"],
    ["#{item!.Read", "#{item!.Re".length, "Read", "Wrong"],
  ]) {
    const result = await until(() => completion(needle, inside),
      value => value && value.items.some(item => item.label === wanted), needle);
    assert.ok(!result.items.some(item => item.label === excluded), needle);
  }
  checks.push("native assertion, null-aware, cascade, lifted and guarded completions including Unicode interpolation");
  for (const [needle, inside] of [["item!.Read", 8], ["item?.Read", 8],
    ["builder..OtherValue()..Read", "builder..OtherValue()..Re".length]]) {
    const at = position(document, needle, inside);
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, at);
    const rendered = hovers.flatMap(hover => hover.contents.map(content => content.value)).join("\n");
    assert.ok(rendered.includes("int32"), rendered);
    const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, at);
    assert.ok(definitions.some(item => (item.targetUri || item.uri).toString() === uri.toString()));
  }
  checks.push("real hover and definition through projected and original receivers");
  const outline = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
  assert.ok(outline.some(item => item.name === "Item"));
  assert.ok(outline.some(item => item.name === "main"));
  checks.push("native outline survives combined conveniences");
  async function replace(text) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    assert.ok(await vscode.workspace.applyEdit(edit));
  }
  for (const [before, after, needle, wanted] of [
    ["  item!.Read();", "  item!.;", "item!.", "Read"],
    ["  item?.Read();", "  item?.;", "item?.", "Read"],
    ["  builder..OtherValue()..Read();", "  builder..OtherValue()..;", "builder..OtherValue()..", "Read"],
  ]) {
    await replace(original.replace(before, after));
    const result = await until(() => completion(needle, needle.length),
      value => value && value.items.some(item => item.label === wanted), "dirty " + needle);
    const item = result.items.find(value => value.label === wanted);
    const range = item.range && (item.range.replacing || item.range);
    assert.ok(range, "native replacement range");
    assert.strictEqual(document.getText(range), "");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, typeof item.insertText === "string" ? item.insertText : item.label);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(document.getText().includes(needle + wanted));
  }
  checks.push("incomplete unsaved receivers and real completion insertion preserve punctuation");
  await replace(original.replace("    item.Read();", "    item = nil;\n    item.Read();"));
  await until(() => Promise.resolve(vscode.languages.getDiagnostics(uri)),
    value => value.some(item => String(item.code && (item.code.value || item.code)) === "NY5006"),
    "guard invalidation diagnostic");
  const diagnostic = vscode.languages.getDiagnostics(uri).find(item => item.code === "NY5006");
  assert.ok(diagnostic.range.start.isEqual(position(document, "    item.Read", "    item.".length)),
    "invalidated receiver diagnostic retains the member source position");
  const invalid = await completion("    item.Read", "    item.Re".length);
  assert.ok(!invalid.items.some(item => item.label === "Read"));
  await replace(original);
  await until(() => Promise.resolve(vscode.languages.getDiagnostics(uri)),
    value => !value.some(item => item.severity === vscode.DiagnosticSeverity.Error), "diagnostic repair");
  assert.strictEqual(fs.readFileSync(uri.fsPath, "utf8"), original);
  checks.push("guard invalidation, diagnostic repair and unchanged physical source");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  fs.writeFileSync(process.env.NYRA_TEST_HOST_REPORT, JSON.stringify({ status: "passed", checks,
    vscode: vscode.version, platform: process.platform, architecture: process.arch,
    extensionVersion: extension.packageJSON.version }, null, 2) + "\n");
};
