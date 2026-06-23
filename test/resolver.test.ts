import { describe, it, expect } from "vitest";
import ts from "typescript";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, type GenerateOptions } from "../src/index.js";

function gen(files: Record<string, string>, opts: Partial<GenerateOptions> = {}): string {
  const { files: out } = generate({ files, bundle: true, ...opts });
  return out.map((f) => f.content).join("\n");
}

function selfContained(code: string): { output: string; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "dtsr-test-"));
  const inFile = join(dir, "input.ts");
  writeFileSync(inFile, code);
  const output = generate({ entry: inFile }).files.map((f) => f.content).join("\n");
  const outFile = join(dir, "out.ts");
  writeFileSync(outFile, output);
  const program = ts.createProgram([outFile], { strict: true, skipLibCheck: true, noEmit: true });
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === outFile)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  return { output, errors };
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function expectDecl(output: string, decl: string): void {
  expect(norm(output)).toContain(norm(decl));
}

describe("user examples", () => {
  it("resolves typebox Static<typeof Schema> to a structural type", () => {
    const out = gen({
      "main.ts": `
        import { Type, type Static } from "@sinclair/typebox";
        const A = Type.Object({ a: Type.String() });
        export type A = Static<typeof A>;
      `,
    });
    expectDecl(out, "export type A = { a: string };");
  });

  it("resolves a generic alias instantiation", () => {
    const out = gen({
      "main.ts": `
        type A<T> = { a: T };
        export type B = A<number>;
      `,
    });
    expectDecl(out, "export type B = { a: number };");
  });
});

describe("primitives and literals", () => {
  it("keeps primitive unions", () => {
    const out = gen({ "m.ts": `export type U = "x" | "y" | 1 | true;` });
    for (const member of ['"x"', '"y"', "1", "true"]) expect(out).toContain(member);
    expect(out).toMatch(/export type U =/);
  });

  it("keeps a bare primitive", () => {
    expectDecl(gen({ "m.ts": `export type N = number;` }), "export type N = number;");
  });
});

describe("objects", () => {
  it("inlines nested named types deeply", () => {
    const out = gen({
      "shared.ts": `export type Money = { cents: number; currency: string };`,
      "main.ts": `
        import { Money } from "./shared";
        export type Order = { total: Money; note?: string };
      `,
      "_entry.ts": `export * from "./main";`,
    }, { entry: "main.ts" });
    expectDecl(out, "export type Order = { total: { cents: number; currency: string }; note?: string };");
  });

  it("strips redundant undefined from optional props", () => {
    const out = gen({ "m.ts": `export type O = { a?: string };` });
    expect(norm(out)).toContain(norm("a?: string"));
    expect(norm(out)).not.toContain("undefined");
  });

  it("preserves readonly", () => {
    const out = gen({ "m.ts": `export type O = { readonly a: number };` });
    expectDecl(out, "readonly a: number");
  });

  it("handles string index signatures", () => {
    const out = gen({ "m.ts": `export type D = { [k: string]: number };` });
    expectDecl(out, "[key: string]: number");
  });
});

describe("arrays and tuples", () => {
  it("resolves array element types", () => {
    const out = gen({
      "m.ts": `type M = { cents: number }; export type L = M[];`,
    });
    expectDecl(out, "export type L = { cents: number }[];");
  });

  it("resolves tuple element types", () => {
    const out = gen({
      "m.ts": `type M = { cents: number }; export type T = [M, number];`,
    });
    expectDecl(out, "export type T = [{ cents: number }, number];");
  });

  it("preserves rest tuple elements", () => {
    const out = gen({ "m.ts": `export type T = [number, ...string[]];` });
    expectDecl(out, "export type T = [number, ...string[]];");
  });
});

describe("functions", () => {
  it("deeply resolves parameter and return types", () => {
    const out = gen({
      "m.ts": `
        type M = { cents: number };
        export type Fn = (a: M, b: number) => M;
      `,
    });
    expectDecl(out, "export type Fn = (a: { cents: number }, b: number) => { cents: number };");
  });
});

describe("generics", () => {
  it("keeps free type parameters on generic exports", () => {
    const out = gen({
      "m.ts": `type Box<T> = { value: T }; export type G<T> = Box<T>;`,
    });
    expectDecl(out, "export type G<T> = { value: T };");
  });
});

describe("library types", () => {
  it("keeps built-in nominal types by name", () => {
    const out = gen({ "m.ts": `export type L = { when: Date; ids: Set<number> };` });
    expectDecl(out, "when: Date");
    expectDecl(out, "ids: Set<number>");
  });
});

describe("recursive types", () => {
  it("emits a recursive type by name without infinite expansion", () => {
    const out = gen({ "m.ts": `export type Rec = { v: number; next: Rec | null };` });
    expectDecl(out, "export type Rec =");
    expect(norm(out)).toMatch(/next: (Rec \| null|null \| Rec)/);
  });

  it("hoists a non-exported recursive type that an export references", () => {
    const out = gen({
      "m.ts": `
        type Node = { value: number; next: Node | null };
        export type List = { head: Node | null };
      `,
    });
    expect(norm(out)).toContain("export type List =");
    expect(norm(out)).toContain("export type Node =");
  });
});

describe("interfaces", () => {
  it("resolves an exported interface to a type", () => {
    const out = gen({
      "m.ts": `type M = { cents: number }; export interface I { price: M; id: string }`,
    });
    expectDecl(out, "price: { cents: number }");
    expectDecl(out, "id: string");
  });
});

function syntaxErrors(content: string): string[] {
  const sf = ts.createSourceFile("out.d.ts", content, ts.ScriptTarget.Latest, true);
  return (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

describe("output validity", () => {
  it("emits syntactically valid TypeScript for a complex module", () => {
    const out = gen({
      "m.ts": `
        type Money = { cents: number };
        type Id<T> = { id: string; value: T };
        export type Order = {
          total: Money;
          lines: Money[];
          tup: [Money, number, ...string[]];
          pay: (a: Money) => boolean;
          tag?: "a" | "b";
          [meta: string]: unknown;
        };
        export type G<T> = Id<T>;
        export interface I { when: Date; ids: Set<number>; readonly xs: number[] }
        export type Rec = { v: number; next: Rec | null };
      `,
    });
    expect(syntaxErrors(out)).toEqual([]);
  });

  it("pretty format also produces valid TypeScript", () => {
    const out = gen(
      { "m.ts": `type M = { cents: number }; export type Order = { total: M; lines: M[] };` },
      { format: "pretty" },
    );
    expect(out).toContain("\n");
    expect(syntaxErrors(out)).toEqual([]);
  });
});

describe("recursion (adversarial regressions)", () => {
  const cases: [string, string][] = [
    ["recursive union (Json)", `export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };`],
    ["recursive tuple", `export type J = number | [J, J];`],
    ["recursive array", `export type J = number | J[];`],
    ["self-referential generic", `export interface List<T> { head: T; tail: List<T> | null; }`],
    ["mutually recursive types", `interface A { b: B | null } interface B { a: A | null } export type Root = { a: A };`],
  ];
  for (const [name, code] of cases) {
    it(`${name} terminates and stays self-contained`, () => {
      expect(selfContained(code).errors).toEqual([]);
    });
  }

  it("recursive generic keeps its type argument", () => {
    expect(norm(gen({ "m.ts": `export interface List<T> { head: T; tail: List<T> | null }` })))
      .toContain(norm("tail: null | List<T>"));
  });
});

describe("built-in containers kept by name (adversarial regressions)", () => {
  const cases: [string, string, string][] = [
    ["Promise", `type U = { id: number }; export type X = Promise<U>;`, "Promise<{ id: number }>"],
    ["Set", `type I = { tag: string }; export type X = Set<I[]>;`, "Set<{ tag: string }[]>"],
    ["Map", `type K = { k: string }; type V = { v: number }; export type X = Map<K, V>;`, "Map<{ k: string }, { v: number }>"],
    ["via alias", `type U = { a: number }; type P = Promise<U>; export type X = P;`, "Promise<{ a: number }>"],
  ];
  for (const [name, code, expected] of cases) {
    it(`keeps ${name} by name with resolved args`, () => {
      const { output, errors } = selfContained(code);
      expect(errors).toEqual([]);
      expect(norm(output)).toContain(norm(expected));
    });
  }
});

describe("deferred type operators (adversarial regressions)", () => {
  const cases: [string, string, string][] = [
    ["keyof free param", `export type Keys<T> = keyof T;`, "keyof T"],
    ["indexed access", `export type Get<T, K extends keyof T> = T[K];`, "T[K]"],
    ["conditional", `export type Cond<T> = T extends string ? number : boolean;`, "T extends string ? number : boolean"],
    ["mapped over free param", `export type P<T> = { [K in keyof T]?: T[K] };`, "[K in keyof T]?: T[K]"],
    ["conditional with infer", `export type Unwrap<T> = T extends Promise<infer U> ? U : T;`, "infer U"],
  ];
  for (const [name, code, expected] of cases) {
    it(`preserves ${name}`, () => {
      const { output, errors } = selfContained(code);
      expect(errors).toEqual([]);
      expect(norm(output)).toContain(norm(expected));
    });
  }

  it("inlines locals referenced inside a deferred mapped type", () => {
    const { output, errors } = selfContained(`type Obj = { a: 1; b: 2 }; export type Pick2<K extends keyof Obj> = { [X in K]: Obj[X] };`);
    expect(errors).toEqual([]);
    expect(output).not.toContain("Obj");
  });
});

describe("synthesized members and modifiers (adversarial regressions)", () => {
  it("resolves Record finite-key values (not any)", () => {
    const { output, errors } = selfContained(`export type R = Record<"a" | "b", number>;`);
    expect(errors).toEqual([]);
    expect(output).not.toMatch(/:\s*any/);
    expect(norm(output)).toContain("a: number");
  });

  it("keeps readonly from a mapped type", () => {
    expect(norm(gen({ "m.ts": `interface U { a: number } export type Ro = { readonly [K in keyof U]: U[K] };` })))
      .toContain("readonly");
  });

  it("inlines enum members to a literal union", () => {
    expect(norm(gen({ "m.ts": `enum Color { Red, Green, Blue } export type W = { c: Color };` })))
      .toContain(norm("c: 0 | 1 | 2"));
  });

  it("inlines string enums to a literal union", () => {
    const out = gen({ "m.ts": `enum E { A = "a", B = "b" } export type W = E;` });
    expect(out).toContain('"a"');
    expect(out).toContain('"b"');
  });

  it("preserves all call overloads", () => {
    const { output, errors } = selfContained(`export interface API { f(x: number): string; f(x: string): number; }`);
    expect(errors).toEqual([]);
    expect(norm(output)).toContain("(x: number): string");
    expect(norm(output)).toContain("(x: string): number");
  });

  it("keeps generic function type parameters and this", () => {
    expect(norm(gen({ "m.ts": `export type Id = <T>(x: T) => T;` }))).toContain(norm("<T>(x: T) => T"));
    expect(norm(gen({ "m.ts": `export type F = (this: { c: number }, x: number) => void;` }))).toContain("this: { c: number }");
  });

  it("parenthesizes a bare function in an intersection", () => {
    const { output, errors } = selfContained(`type F = (x: number) => string; type O = { p: boolean }; export type X = F & O;`);
    expect(errors).toEqual([]);
    expect(norm(output)).toContain(norm("((x: number) => string) & { p: boolean }"));
  });
});

describe("type parameter clauses (adversarial regressions)", () => {
  it("inlines constraints that reference local types", () => {
    const { output, errors } = selfContained(`type C = { id: number }; export type W<T extends C> = { item: T };`);
    expect(errors).toEqual([]);
    expect(norm(output)).toContain(norm("T extends { id: number }"));
  });

  it("inlines defaults that reference local types", () => {
    const { output, errors } = selfContained(`type H = { x: number }; export interface B<T = H> { val: T; }`);
    expect(errors).toEqual([]);
    expect(norm(output)).toContain(norm("T = { x: number }"));
  });

  it("emits local types referenced inside a deferred conditional", () => {
    const { output, errors } = selfContained(
      `type Foo = { a: 1 }; type Bar = { b: 2 }; export type C<T> = T extends Foo ? Bar : never;`,
    );
    expect(errors).toEqual([]);
    expect(norm(output)).toContain("export type Foo = { a: 1 }");
    expect(norm(output)).toContain("export type Bar = { b: 2 }");
  });
});

describe("output modes", () => {
  it("bundle=false emits one file per source module", () => {
    const { files } = generate({
      files: {
        "a.ts": `export type A = { a: number };`,
        "b.ts": `export type B = { b: string };`,
      },
      entry: ["a.ts", "b.ts"],
      bundle: false,
    });
    expect(files.map((f) => f.path).sort()).toEqual(["a.d.ts", "b.d.ts"]);
  });

  it("bundle=true merges into a single file", () => {
    const { files } = generate({
      files: {
        "a.ts": `export type A = { a: number };`,
        "b.ts": `export type B = { b: string };`,
      },
      entry: ["a.ts", "b.ts"],
      bundle: true,
    });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("index.d.ts");
  });
});
