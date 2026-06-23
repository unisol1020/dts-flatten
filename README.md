# dts-flatten

Generate minimal `.d.ts` by resolving TypeScript types down to their structural primitives.

It drives the TypeScript type checker to expand aliases, utility types, generics and
imports into their underlying shape, so the output is self-contained and small.

```ts
// in
import { Type, type Static } from "@sinclair/typebox";
const A = Type.Object({ a: Type.String() });
export type A = Static<typeof A>;

// out
export type A = { a: string };
```

```ts
// in
type A<T> = { a: T };
export type B = A<number>;

// out
export type B = { a: number };
```

Resolution is **deep**: nested named types are inlined recursively down to primitives.

```ts
// in
type Money = { cents: number };
export type Order = { total: Money; lines: Money[] };

// out
export type Order = { total: { cents: number }; lines: { cents: number }[] };
```

What is kept by name (not inlined):

- Built-in nominal types — `Date`, `Set`, `Map`, `Promise`, `Array`, `RegExp`, … (type
  arguments are still resolved, e.g. `Set<{ cents: number }>`).
- Recursive types, to avoid infinite expansion (`type Rec = { next: Rec | null }`).
- Free generic parameters on exported generics (`export type G<T> = { value: T }`).

## Install

```sh
npm install -D dts-flatten typescript
```

`typescript` is a peer dependency.

## API

```ts
import { generate } from "dts-flatten";

const { files } = generate({
  entry: ["src/models.ts"], // file(s), or use `tsconfig`
  bundle: false,            // true => single index.d.ts; false => one .d.ts per source file
  format: "inline",         // "inline" (default, compact) or "pretty" (multi-line)
  outDir: "types",          // optional: also write the files to disk
});

for (const f of files) console.log(f.path, f.content);
```

Options:

| option            | type                                  | default    | meaning                                              |
| ----------------- | ------------------------------------- | ---------- | ---------------------------------------------------- |
| `entry`           | `string \| string[]`                  | —          | entry source file(s)                                 |
| `tsconfig`        | `string`                              | —          | load compiler options + files from a tsconfig        |
| `files`           | `Record<string, string>`              | —          | in-memory virtual files (programmatic / testing)     |
| `bundle`          | `boolean`                             | `false`    | merge all output into a single `index.d.ts`          |
| `format`          | `"inline" \| "pretty"`                | `"inline"` | compact single-line vs. multi-line formatting        |
| `outDir`          | `string`                              | —          | write the generated files to this directory          |
| `compilerOptions` | `ts.CompilerOptions`                  | —          | overrides merged over the defaults / tsconfig        |

Provide exactly one source: `entry`, `tsconfig`, or `files`.

## CLI

```sh
dts-flatten src/models.ts --bundle --pretty -o types
dts-flatten -p tsconfig.json -o types
```

Without `-o`/`--out`, the resolved declarations are printed to stdout.

## Scope

Resolves exported **type aliases and interfaces**. Value declarations (`const`,
`function`, `class` instances) are out of scope — use `tsc --declaration` for those.

Enums resolve to a literal-value union (`enum Color { Red, Green }` referenced as a
type becomes `0 | 1`), so the output stays self-contained.

## Limitations

- **`typeof someValue`** keeps the reference (e.g. `typeof s` for a `unique symbol`).
  A value's type has no structural form, so it cannot be inlined.
- **Computed symbol keys** other than well-known `Symbol.*` members are dropped
  (an arbitrary `unique symbol` key cannot be expressed structurally).
