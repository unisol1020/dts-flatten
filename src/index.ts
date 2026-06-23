import ts from "typescript";
import { dirname, join, basename, resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { Resolver } from "./resolve.js";

export interface GenerateOptions {
  entry?: string | string[];
  tsconfig?: string;
  files?: Record<string, string>;
  bundle?: boolean;
  outDir?: string;
  format?: "inline" | "pretty";
  compilerOptions?: ts.CompilerOptions;
}

export interface OutputFile {
  path: string;
  content: string;
}

export interface GenerateResult {
  files: OutputFile[];
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
};

export function generate(options: GenerateOptions): GenerateResult {
  const { program, entries } = buildProgram(options);
  const checker = program.getTypeChecker();
  const resolver = new Resolver(checker, program);

  const groups = entries
    .map((file) => ({ file, declarations: resolver.resolveModule(file).declarations }))
    .filter((g) => g.declarations.length > 0);

  const raw = options.bundle
    ? bundle(groups)
    : groups.map((g) => ({
        path: outName(g.file.fileName),
        content: g.declarations.join("\n") + "\n",
      }));

  const files =
    options.format === "pretty"
      ? raw.map((f) => ({ path: f.path, content: prettyPrint(f.content) }))
      : raw;

  if (options.outDir) write(files, options.outDir);
  return { files };
}

function prettyPrint(content: string): string {
  const sf = ts.createSourceFile("output.d.ts", content, ts.ScriptTarget.Latest, false);
  return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(sf);
}

function bundle(groups: { declarations: string[] }[]): OutputFile[] {
  const seen = new Set<string>();
  const declarations: string[] = [];
  for (const g of groups)
    for (const d of g.declarations)
      if (!seen.has(d)) {
        seen.add(d);
        declarations.push(d);
      }
  return [{ path: "index.d.ts", content: declarations.join("\n") + "\n" }];
}

function write(files: OutputFile[], outDir: string): void {
  for (const f of files) {
    const target = join(outDir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
}

function outName(fileName: string): string {
  return basename(fileName).replace(/\.tsx?$/, ".d.ts");
}

function buildProgram(options: GenerateOptions): {
  program: ts.Program;
  entries: ts.SourceFile[];
} {
  if (options.files) return buildVirtualProgram(options);

  let rootNames = toArray(options.entry);
  let compilerOptions = { ...DEFAULT_OPTIONS, ...options.compilerOptions };

  if (options.tsconfig) {
    const config = ts.readConfigFile(options.tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config.config ?? {},
      ts.sys,
      dirname(options.tsconfig),
    );
    compilerOptions = { ...parsed.options, ...options.compilerOptions };
    if (!rootNames.length) rootNames = parsed.fileNames;
  }

  if (!rootNames.length) throw new Error("dts-resolver: provide `entry`, `tsconfig`, or `files`.");

  const program = ts.createProgram(rootNames, compilerOptions);
  const entries = rootNames
    .map((name) => program.getSourceFile(name))
    .filter((f): f is ts.SourceFile => f !== undefined);
  return { program, entries };
}

function buildVirtualProgram(options: GenerateOptions): {
  program: ts.Program;
  entries: ts.SourceFile[];
} {
  const base = ts.sys.getCurrentDirectory();
  const compilerOptions = { ...DEFAULT_OPTIONS, ...options.compilerOptions };
  const virtual = new Map<string, string>();
  for (const [name, text] of Object.entries(options.files!)) virtual.set(resolve(base, name), text);

  const sources = new Map<string, ts.SourceFile>();
  const sourceFor = (fileName: string): ts.SourceFile | undefined => {
    if (sources.has(fileName)) return sources.get(fileName);
    const text = virtual.get(fileName) ?? ts.sys.readFile(fileName);
    if (text === undefined) return undefined;
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    sources.set(fileName, sf);
    return sf;
  };

  const host: ts.CompilerHost = {
    getSourceFile: sourceFor,
    writeFile: () => {},
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    getCurrentDirectory: () => base,
    getCanonicalFileName: (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    fileExists: (f) => virtual.has(f) || ts.sys.fileExists(f),
    readFile: (f) => virtual.get(f) ?? ts.sys.readFile(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    getDirectories: (d) => ts.sys.getDirectories(d),
    realpath: ts.sys.realpath,
  };

  const rootNames = (toArray(options.entry).length
    ? toArray(options.entry)
    : Object.keys(options.files!)
  ).map((name) => resolve(base, name));
  const program = ts.createProgram(rootNames, compilerOptions, host);
  const entries = rootNames
    .map((name) => program.getSourceFile(name))
    .filter((f): f is ts.SourceFile => f !== undefined);
  return { program, entries };
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
