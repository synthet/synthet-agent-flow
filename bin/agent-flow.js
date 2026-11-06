#!/usr/bin/env node
// Thin shim: silence node:sqlite's ExperimentalWarning, then run the compiled CLI.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === "string" ? warning : warning && warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(text))) return;
  return emit.call(process, warning, ...rest);
};
const { main } = await import("../dist/cli/main.js");
const code = await main(process.argv.slice(2));
process.exitCode = typeof code === "number" ? code : 0;
