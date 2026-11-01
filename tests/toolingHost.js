"use strict";

// Runs inside an isolated, real VS Code Extension Host. The launcher owns every
// workspace, process wrapper and settings file supplied through the environment.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const vscode = require("vscode");

async function until(operation, accept, label, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let value;
  while (Date.now() < deadline) {
    value = await operation();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Deadline waiting for ${label}: ${JSON.stringify(value)}`);
}

function position(document, needle, inside = 1) {
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, needle);
  return document.positionAt(offset + inside);
}

exports.run = async function () {
  const checks = [];
  const extension = vscode.extensions.getExtension("nyra.nyra-lang");
  assert.ok(extension, "development extension registered");
  await extension.activate();
  const folder = vscode.workspace.workspaceFolders[0];
  const uri = vscode.Uri.joinPath(folder.uri, "main.ny");
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.strictEqual(document.languageId, "nyra");
  const symbols = () => vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
  let outline = await until(symbols, value => value && value.some(item => item.name === "Point"), "native outline");
  const point = outline.find(item => item.name === "Point");
  assert.deepStrictEqual(point.children.map(item => item.name), ["value"]);
  assert.strictEqual(document.getText(point.selectionRange), "Point");
  assert.ok(!outline.some(item => item.name === "PartValue"));
  checks.push("native Outline and source selection ranges");

  const completions = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri,
    position(document, "local +"));
  const local = completions.items.find(item => item.label === "local");
  assert.ok(local && local.sortText.startsWith("0:"));
  assert.ok(completions.items.some(item => item.label === "PartValue"));
  assert.ok(!completions.items.some(item => item.label === "fromOther"));
  const range = local.range && (local.range.replacing || local.range);
  assert.ok(range, "completion carries a replacement range");
  assert.strictEqual(document.getText(range), "local");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, range, typeof local.insertText === "string" ? local.insertText : local.label);
  assert.ok(await vscode.workspace.applyEdit(edit));
  checks.push("scoped completion ranking and real editor insertion");

  const definitions = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri,
    position(document, "PartValue()"));
  assert.ok(definitions.length);
  assert.strictEqual((definitions[0].targetUri || definitions[0].uri).fsPath,
    path.join(folder.uri.fsPath, "part.ny"));
  const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri,
    position(document, "PartValue()"));
  const renderedHover = hovers.flatMap(hover => hover.contents.map(content => content.value)).join("\n");
  assert.ok(renderedHover.replace(/\u00a0|&nbsp;|\\ /g, " ").includes("Part documentation"), renderedHover);
  checks.push("cross-part definition and readable API hover");

  const original = document.getText();
  const broken = new vscode.WorkspaceEdit();
  const start = original.indexOf("PartValue()");
  broken.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(start + 9)), "NoSuchApi");
  assert.ok(await vscode.workspace.applyEdit(broken));
  await until(() => Promise.resolve(vscode.languages.getDiagnostics(uri)),
    value => value.some(item => String(item.code && (item.code.value || item.code)) === "NY5007"), "unsaved diagnostic");
  const repaired = new vscode.WorkspaceEdit();
  repaired.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
  assert.ok(await vscode.workspace.applyEdit(repaired));
  await until(() => Promise.resolve(vscode.languages.getDiagnostics(uri)),
    value => !value.some(item => item.source === "nyra"), "repaired compiler diagnostic");
  assert.ok(document.isDirty, "test changes remain in memory");
  checks.push("real incremental unsaved edits and diagnostic repair");

  const configUri = vscode.Uri.joinPath(folder.uri, "lint.yaml");
  const config = await vscode.workspace.openTextDocument(configUri);
  assert.notStrictEqual(config.languageId, "nyra", "YAML retains its own language providers");
  const diskConfig = fs.readFileSync(configUri.fsPath, "utf8");
  const dirtyConfig = diskConfig.replace("no-trailing-whitespace: false", "no-trailing-whitespace: true");
  const configEdit = new vscode.WorkspaceEdit();
  configEdit.replace(configUri, new vscode.Range(config.positionAt(0), config.positionAt(config.getText().length)), dirtyConfig);
  assert.ok(await vscode.workspace.applyEdit(configEdit));
  const lintActive = () => Promise.resolve(vscode.languages.getDiagnostics(uri).some(item => item.code === "NYL0001"));
  await until(lintActive, value => value, "unsaved YAML lint configuration");
  assert.strictEqual(fs.readFileSync(configUri.fsPath, "utf8"), diskConfig);
  checks.push("unsaved YAML overlays without Nyra providers on YAML or disk writes");

  const toolchain = require(path.join(extension.extensionPath, "windowToolchain"));
  const selected = toolchain.resolveWindowSdkPath(vscode, false);
  assert.ok(vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, 0,
    { uri: vscode.Uri.file(process.env.NYRA_TEST_SECOND_ROOT), name: "second" }));
  await until(() => Promise.resolve(vscode.workspace.workspaceFolders.length), value => value === 2, "second workspace");
  assert.strictEqual(toolchain.resolveWindowSdkPath(vscode, false), selected);
  await vscode.commands.executeCommand("nyra.restartAnalyzer");
  await until(symbols, value => value && value.some(item => item.name === "Point"), "restarted analyzer");
  await until(lintActive, value => value, "dirty YAML replay after explicit restart");
  assert.strictEqual(document.getText(), original);
  checks.push("multi-root window SDK stability and explicit restart with dirty buffers");

  // The launcher wrapper writes only this task's analyzer PID. Exec preserves
  // that PID, so no unrelated editor, SDK or analyzer process can be selected.
  const pidFile = process.env.NYRA_TEST_ANALYZER_PIDS;
  const windowsAnalyzer = process.env.NYRA_TEST_NATIVE_ANALYZER;
  if (pidFile || windowsAnalyzer) {
    const pids = () => {
      if (pidFile) return fs.readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      // Windows exec does not preserve a wrapper PID. Match only the exact
      // executable copied into this isolated launch's owned task directory.
      const literal = windowsAnalyzer.replace(/'/g, "''");
      const script = `Get-Process | Where-Object { $_.Path -eq '${literal}' } | ForEach-Object { $_.Id }`;
      const values = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true }).trim();
      return values ? values.split(/\s+/).map(Number) : [];
    };
    const before = pids();
    assert.ok(before.length && before.every(pid => Number.isInteger(pid) && pid > 0));
    if (windowsAnalyzer) assert.strictEqual(before.length, 1, "one owned native analyzer");
    process.kill(before[before.length - 1], "SIGKILL");
    await until(() => Promise.resolve(pids()), value => value.some(pid => !before.includes(pid)), "crash restart");
    await until(symbols, value => value && value.some(item => item.name === "Point"), "recovered native queries");
    await until(lintActive, value => value, "dirty YAML replay after crash recovery");
    checks.push("owned analyzer crash and language-client recovery");
  }

  await require("./nativeCreationHost").run();
  checks.push("native package manager preview/create/cancel in Extension Host");
  await vscode.window.showTextDocument(config);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await until(lintActive, value => !value, "reverted YAML lint configuration");
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  if (process.env.NYRA_TEST_DEBUG) {
    const adapter = vscode.extensions.getExtension("vadimcn.vscode-lldb");
    assert.ok(adapter, "CodeLLDB is registered in the isolated test host");
    await adapter.activate();
    await vscode.window.showTextDocument(document);
    const taskPath = path.join(folder.uri.fsPath, ".vscode", "tasks.json");
    const launchPath = path.join(folder.uri.fsPath, ".vscode", "launch.json");
    const userTasks = fs.readFileSync(taskPath, "utf8");
    const userLaunch = fs.readFileSync(launchPath, "utf8");
    const stops = [];
    const sessions = [];
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory("lldb", {
      createDebugAdapterTracker(session) {
        sessions.push(session);
        return { onDidSendMessage(message) {
          if (message.type === "event" && message.event === "stopped") stops.push({ session, body: message.body });
        } };
      },
    });
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(7, 2)));
    vscode.debug.addBreakpoints([breakpoint]);
    try {
      await vscode.commands.executeCommand("nyra.debug.currentFile");
      await until(() => Promise.resolve(stops), value => value.some(stop => stop.body.reason === "breakpoint"),
        "live source breakpoint", 60);
      const stop = stops.find(item => item.body.reason === "breakpoint");
      const stack = await stop.session.customRequest("stackTrace", { threadId: stop.body.threadId });
      assert.ok(stack.stackFrames.some(frame => frame.source && frame.source.path === uri.fsPath && frame.line === 8), stack);
      await stop.session.customRequest("continue", { threadId: stop.body.threadId });
      await until(() => Promise.resolve(vscode.debug.activeDebugSession), value => !value, "debuggee termination");
      assert.strictEqual(fs.readFileSync(taskPath, "utf8"), userTasks);
      assert.strictEqual(fs.readFileSync(launchPath, "utf8"), userLaunch);
      checks.push("extension build and live source breakpoint with preserved user task/launch JSON");
    } finally {
      vscode.debug.removeBreakpoints([breakpoint]);
      for (const session of sessions) await vscode.debug.stopDebugging(session);
      tracker.dispose();
    }
  }
  fs.writeFileSync(process.env.NYRA_TEST_HOST_REPORT, JSON.stringify({ status: "passed", checks,
    vscode: vscode.version, platform: process.platform, architecture: process.arch,
    extensionVersion: extension.packageJSON.version, selectedSdk: selected }, null, 2) + "\n");
  console.log("Nyra tooling Extension Host passed: " + checks.join("; "));
};
