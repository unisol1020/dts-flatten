#!/usr/bin/env node
import { generate } from "./index.js";

interface Args {
  entry: string[];
  tsconfig?: string;
  outDir?: string;
  bundle: boolean;
  pretty: boolean;
}

function parse(argv: string[]): Args {
  const args: Args = { entry: [], bundle: false, pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle") args.bundle = true;
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--out" || a === "-o") args.outDir = argv[++i];
    else if (a === "--project" || a === "-p") args.tsconfig = argv[++i];
    else args.entry.push(a);
  }
  return args;
}

function main(): void {
  const args = parse(process.argv.slice(2));
  if (!args.entry.length && !args.tsconfig) {
    console.error("Usage: dts-flatten <entry.ts...> [-p tsconfig.json] [-o outDir] [--bundle] [--pretty]");
    process.exit(1);
  }

  const { files } = generate({
    entry: args.entry,
    tsconfig: args.tsconfig,
    bundle: args.bundle,
    outDir: args.outDir,
    format: args.pretty ? "pretty" : "inline",
  });

  if (args.outDir) {
    for (const f of files) console.error(`wrote ${f.path}`);
  } else {
    for (const f of files) process.stdout.write(f.content);
  }
}

main();
