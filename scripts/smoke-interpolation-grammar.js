"use strict";

// Exercise the real TextMate/Oniguruma state machine used by VS Code, including
// multiline rule stacks. No extension host or alternate expression parser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const textmate = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

async function main() {
  const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const grammarPath = path.join(__dirname, "../syntaxes/nyra.tmLanguage.json");
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: value => new oniguruma.OnigString(value),
    }),
    loadGrammar: async scope => scope === "source.nyra"
      ? textmate.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath) : null,
  });
  const grammar = await registry.loadGrammarWithConfiguration("source.nyra", 1, {
    embeddedLanguages: { "meta.embedded.expression.nyra": 1 },
  });
  let assertions = 0;
  function at(line, marker, scope, present = true, occurrence = 0, stack = textmate.INITIAL) {
    let index = -1;
    for (let count = 0; count <= occurrence; count++) index = line.indexOf(marker, index + 1);
    assert.ok(index >= 0, marker);
    const result = grammar.tokenizeLine(line, stack);
    const token = result.tokens.find(value => value.startIndex <= index && value.endIndex > index);
    assert.equal(token.scopes.includes(scope), present, `${marker}: ${token.scopes.join(" ")}`);
    assertions++;
    return result;
  }
  for (let slashes = 0; slashes <= 4; slashes++) {
    const line = `let text = "${"\\".repeat(slashes)}#{42}"; return 0;`;
    at(line, "42", "constant.numeric.integer.nyra", slashes % 2 === 0);
    at(line, "return", "meta.embedded.expression.nyra", false);
    at(line, "return", "keyword.control.nyra");
  }
  // Convenience operators use the same embedded-code grammar as normal source.
  for (const line of [
    'builder..First()..Second();',
    'item?.Refresh();',
    'item!.Refresh();',
    'let text = "#{item!..First()..Second()}";',
  ]) {
    const operator = line.includes("..") ? ".." : line.includes("?.") ? "?." : "!";
    at(line, operator, "keyword.operator.nyra");
    at(line, line.includes("First") ? "First" : "Refresh", "meta.embedded.expression.nyra", line.includes("#{"),
      0, textmate.INITIAL);
  }
  const nested = 'let text = "#{Point{ x: 42, text: "} #{true}" }.x /* } */}"; return 0;';
  at(nested, "42", "constant.numeric.integer.nyra");
  at(nested, "true", "constant.language.boolean.nyra");
  at(nested, "/* } */", "comment.block.nyra");
  at(nested, "return", "meta.embedded.expression.nyra", false);
  at(nested, "return", "keyword.control.nyra");
  const character = 'let text = "#{Pick(\'}\')}"; return 0;';
  at(character, "'}'", "string.quoted.single.nyra");
  at(character, "return", "meta.embedded.expression.nyra", false);
  const first = grammar.tokenizeLine('let text = "#{1 // } " ignored', textmate.INITIAL);
  at(' + 2}"; return 0;', "2", "constant.numeric.integer.nyra", true, 0, first.ruleStack);
  const last = at(' + 2}"; return 0;', "return", "meta.embedded.expression.nyra", false, 0, first.ruleStack);
  assert.equal(last.ruleStack.depth, 1);
  // Embedded code resets the inherited string token type; nested text retains it.
  const semantic = '"#{42 + "plain"}"';
  const encoded = grammar.tokenizeLine2(semantic, textmate.INITIAL).tokens;
  function tokenType(index) {
    let metadata = 0;
    for (let i = 0; i < encoded.length; i += 2) {
      if (encoded[i] > index) break;
      metadata = encoded[i + 1];
    }
    return (metadata >>> 8) & 3;
  }
  assert.equal(tokenType(semantic.indexOf("42")), 0);
  assert.equal(tokenType(semantic.indexOf("plain")), 2);
  console.log(`interpolation grammar: ${assertions + 3} controls passed`);
  registry.dispose();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
