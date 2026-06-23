import ts from "typescript";

const MAX_DEPTH = 200;
const CHECK_FLAGS_READONLY = 1 << 3;

const PRINT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.InTypeAlias |
  ts.TypeFormatFlags.UseFullyQualifiedType;

const PRIMITIVE_FLAGS =
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.Never |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.NonPrimitive;

const WELL_KNOWN_SYMBOL = /^__@(\w+)@\d+$/;

export interface Resolved {
  declarations: string[];
}

export class Resolver {
  private hoisted = new Map<ts.Symbol, ts.Type>();
  private recursive = new Set<ts.Symbol>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly program: ts.Program,
  ) {}

  resolveModule(file: ts.SourceFile): Resolved {
    const moduleSymbol = this.checker.getSymbolAtLocation(file);
    const exports = moduleSymbol ? this.checker.getExportsOfModule(moduleSymbol) : [];
    const roots = exports
      .map((sym) => this.declarationOf(sym))
      .filter((d): d is NamedType => d !== null);

    for (const root of roots) this.walk(root.type, [], 0);

    const declarations: string[] = [];
    const emitted = new Set<ts.Symbol>();
    for (const root of roots) {
      declarations.push(this.emit(root.name, root.symbol, root.type, root.params));
      emitted.add(root.symbol);
    }
    this.emitHoisted(declarations, emitted);
    return { declarations };
  }

  private emitHoisted(declarations: string[], emitted: Set<ts.Symbol>): void {
    let pending = [...this.hoisted].filter(([sym]) => !emitted.has(sym));
    while (pending.length) {
      for (const [sym, type] of pending) {
        emitted.add(sym);
        declarations.push(this.emit(sym.name, sym, type, this.paramsOf(sym)));
      }
      pending = [...this.hoisted].filter(([sym]) => !emitted.has(sym));
    }
  }

  private emit(name: string, sym: ts.Symbol, type: ts.Type, params: string): string {
    const aliasDecl = sym.declarations?.find(ts.isTypeAliasDeclaration);
    if (aliasDecl) this.hoistConditionalLocals(aliasDecl.type);
    return `export type ${name}${params} = ${this.resolve(type, [], 0, sym)};`;
  }

  private hoistConditionalLocals(node: ts.TypeNode): void {
    const collect = (n: ts.Node): void => {
      if (ts.isTypeReferenceNode(n)) this.hoistEntity(n.typeName);
      ts.forEachChild(n, collect);
    };
    const scan = (n: ts.Node): void => {
      if (ts.isConditionalTypeNode(n)) collect(n);
      else ts.forEachChild(n, scan);
    };
    scan(node);
  }

  private hoistEntity(name: ts.EntityName): void {
    const sym = this.checker.getSymbolAtLocation(name);
    if (!sym) return;
    const target = sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
    const decl = target.declarations?.find(
      (d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d),
    );
    if (!decl || this.program.isSourceFileDefaultLibrary(decl.getSourceFile())) return;
    const type = ts.isTypeAliasDeclaration(decl)
      ? this.checker.getTypeFromTypeNode(decl.type)
      : this.checker.getDeclaredTypeOfSymbol(target);
    if (!this.hoisted.has(target)) this.hoisted.set(target, type);
  }

  private resolve(type: ts.Type, path: number[], depth: number, root?: ts.Symbol): string {
    if (depth > MAX_DEPTH) return this.print(type);
    const f = type.flags;

    if (f & ts.TypeFlags.EnumLiteral && !(f & ts.TypeFlags.Union)) return this.literal(type);
    if (f & ts.TypeFlags.TypeParameter) return this.print(type);
    if (f & PRIMITIVE_FLAGS) return this.print(type);
    if (f & ts.TypeFlags.Index)
      return `keyof ${this.resolve((type as ts.IndexType).type, path, depth + 1)}`;
    if (f & ts.TypeFlags.IndexedAccess) {
      const ia = type as ts.IndexedAccessType;
      return `${this.resolve(ia.objectType, path, depth + 1)}[${this.resolve(ia.indexType, path, depth + 1)}]`;
    }
    if (f & ts.TypeFlags.Instantiable) return this.print(type);

    const named = this.namedSymbol(type);
    const atRoot = named === root && depth === 0;
    if (named && !atRoot && (path.includes(this.id(type)) || this.recursive.has(named))) {
      this.hoisted.set(named, type);
      return this.byName(named, this.aliasArgs(type), path, depth);
    }

    const next = named ? [...path, this.id(type)] : path;

    if (this.checker.isArrayType(type)) {
      const el = this.resolve(this.checker.getTypeArguments(type as ts.TypeReference)[0], next, depth + 1);
      return `${this.readonlyArray(type) ? "readonly " : ""}${this.wrapArray(el)}[]`;
    }
    if (this.checker.isTupleType(type)) return this.tuple(type as ts.TypeReference, next, depth);

    const direct = type.getSymbol();
    if (direct && this.keepByName(direct))
      return this.byName(direct, this.refArgs(type), next, depth);

    if (this.isDeferredMapped(type)) return this.mapped(type, next, depth);

    if (f & ts.TypeFlags.Union)
      return (type as ts.UnionType).types.map((t) => this.operand(t, next, depth)).join(" | ");
    if (f & ts.TypeFlags.Intersection)
      return (type as ts.IntersectionType).types.map((t) => this.operand(t, next, depth)).join(" & ");

    const calls = type.getCallSignatures();
    if (
      calls.length === 1 &&
      type.getConstructSignatures().length === 0 &&
      type.getProperties().length === 0 &&
      this.checker.getIndexInfosOfType(type).length === 0
    )
      return this.signature(calls[0], next, depth, "arrow");

    return this.object(type, next, depth);
  }

  private operand(type: ts.Type, path: number[], depth: number): string {
    const s = this.resolve(type, path, depth + 1);
    return type.getCallSignatures().length ? `(${s})` : s;
  }

  private object(type: ts.Type, path: number[], depth: number): string {
    const parts: string[] = [];
    const mappedReadonly = this.mappedReadonly(type);

    for (const info of this.checker.getIndexInfosOfType(type)) {
      const ro = info.isReadonly ? "readonly " : "";
      parts.push(`${ro}[key: ${this.resolve(info.keyType, path, depth + 1)}]: ${this.resolve(info.type, path, depth + 1)}`);
    }
    for (const prop of type.getProperties()) {
      const part = this.property(prop, path, depth, mappedReadonly);
      if (part) parts.push(part);
    }
    for (const call of type.getCallSignatures()) parts.push(this.signature(call, path, depth, "colon"));
    for (const ctor of type.getConstructSignatures())
      parts.push(`new ${this.signature(ctor, path, depth, "colon")}`);

    return parts.length ? `{ ${parts.join("; ")} }` : "{}";
  }

  private property(prop: ts.Symbol, path: number[], depth: number, forceReadonly: boolean): string | null {
    const name = this.propertyName(prop);
    if (name === null) return null;
    const optional = !!(prop.flags & ts.SymbolFlags.Optional);
    const readonly = forceReadonly || this.isReadonly(prop);
    let type = this.checker.getTypeOfSymbol(prop);
    if (optional) type = this.stripUndefined(type);
    return `${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${this.resolve(type, path, depth + 1)}`;
  }

  private signature(sig: ts.Signature, path: number[], depth: number, kind: "arrow" | "colon"): string {
    const tparams = this.signatureTypeParams(sig);
    const params: string[] = [];

    const thisParam = sig.thisParameter;
    if (thisParam) params.push(`this: ${this.resolve(this.checker.getTypeOfSymbol(thisParam), path, depth + 1)}`);

    for (const p of sig.getParameters()) {
      const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const optional = !!decl?.questionToken;
      const rest = !!decl?.dotDotDotToken;
      let type = this.checker.getTypeOfSymbol(p);
      if (optional) type = this.stripUndefined(type);
      params.push(`${rest ? "..." : ""}${p.name}${optional ? "?" : ""}: ${this.resolve(type, path, depth + 1)}`);
    }

    const ret = this.resolve(sig.getReturnType(), path, depth + 1);
    const head = `${tparams}(${params.join(", ")})`;
    return kind === "arrow" ? `${head} => ${ret}` : `${head}: ${ret}`;
  }

  private mapped(type: ts.Type, path: number[], depth: number): string {
    const decl = (type as unknown as { declaration?: ts.MappedTypeNode }).declaration;
    if (!decl) return this.print(type);

    const key = decl.typeParameter.name.text;
    const constraint = decl.typeParameter.constraint
      ? this.resolve(this.checker.getTypeFromTypeNode(decl.typeParameter.constraint), path, depth + 1)
      : "never";
    const as = decl.nameType
      ? ` as ${this.resolve(this.checker.getTypeFromTypeNode(decl.nameType), path, depth + 1)}`
      : "";
    const ro = this.mappedModifier(decl.readonlyToken, "readonly ");
    const opt = this.mappedModifier(decl.questionToken, "?");
    const value = decl.type
      ? this.resolve(this.checker.getTypeFromTypeNode(decl.type), path, depth + 1)
      : "unknown";
    return `{ ${ro}[${key} in ${constraint}${as}]${opt}: ${value} }`;
  }

  private mappedModifier(token: ts.Node | undefined, text: string): string {
    if (!token) return "";
    if (token.kind === ts.SyntaxKind.MinusToken) return `-${text}`;
    if (token.kind === ts.SyntaxKind.PlusToken) return `+${text}`;
    return text;
  }

  private tuple(type: ts.TypeReference, path: number[], depth: number): string {
    const target = type.target as ts.TupleType;
    const args = this.checker.getTypeArguments(type);
    const flags = target.elementFlags ?? [];
    const labels = target.labeledElementDeclarations;
    const parts = args.map((arg, i) => {
      const ef = flags[i] ?? ts.ElementFlags.Required;
      const label = labels?.[i] ? `${(labels[i] as ts.NamedTupleMember).name.getText()}: ` : "";
      const value = this.resolve(arg, path, depth + 1);
      if (ef & ts.ElementFlags.Rest) return `...${label}${this.wrapArray(value)}[]`;
      return `${label}${value}${ef & ts.ElementFlags.Optional ? "?" : ""}`;
    });
    const ro = (target as unknown as { readonly?: boolean }).readonly ? "readonly " : "";
    return `${ro}[${parts.join(", ")}]`;
  }

  private byName(sym: ts.Symbol, args: readonly ts.Type[], path: number[], depth: number): string {
    if (!args.length) return sym.name;
    return `${sym.name}<${args.map((a) => this.resolve(a, path, depth + 1)).join(", ")}>`;
  }

  private walk(type: ts.Type, path: number[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    const f = type.flags;
    if (f & (PRIMITIVE_FLAGS | ts.TypeFlags.TypeParameter | ts.TypeFlags.Instantiable | ts.TypeFlags.EnumLike))
      return;

    const named = this.namedSymbol(type);
    if (named && path.includes(this.id(type))) {
      this.recursive.add(named);
      return;
    }
    const next = named ? [...path, this.id(type)] : path;

    if (this.checker.isArrayType(type)) {
      this.walk(this.checker.getTypeArguments(type as ts.TypeReference)[0], next, depth + 1);
      return;
    }
    if (this.checker.isTupleType(type)) {
      for (const a of this.checker.getTypeArguments(type as ts.TypeReference)) this.walk(a, next, depth + 1);
      return;
    }
    const direct = type.getSymbol();
    if (direct && this.keepByName(direct)) {
      for (const a of this.refArgs(type)) this.walk(a, next, depth + 1);
      return;
    }
    if (this.isDeferredMapped(type)) return;

    if (f & ts.TypeFlags.UnionOrIntersection) {
      for (const t of (type as ts.UnionOrIntersectionType).types) this.walk(t, next, depth + 1);
      return;
    }
    for (const sig of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (sig.thisParameter) this.walk(this.checker.getTypeOfSymbol(sig.thisParameter), next, depth + 1);
      for (const p of sig.getParameters()) this.walk(this.checker.getTypeOfSymbol(p), next, depth + 1);
      this.walk(sig.getReturnType(), next, depth + 1);
    }
    for (const info of this.checker.getIndexInfosOfType(type)) this.walk(info.type, next, depth + 1);
    for (const prop of type.getProperties()) this.walk(this.checker.getTypeOfSymbol(prop), next, depth + 1);
  }

  private id(type: ts.Type): number {
    return (type as unknown as { id: number }).id;
  }

  private objectFlags(type: ts.Type): number {
    return type.flags & ts.TypeFlags.Object ? (type as ts.ObjectType).objectFlags : 0;
  }

  private declarationOf(sym: ts.Symbol): NamedType | null {
    const target = sym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(sym) : sym;
    const decl = target.declarations?.find(
      (d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d),
    );
    if (!decl) return null;
    const type = ts.isTypeAliasDeclaration(decl)
      ? this.checker.getTypeFromTypeNode(decl.type)
      : this.checker.getDeclaredTypeOfSymbol(target);
    return { name: sym.name, symbol: target, type, params: this.paramsFromDecl(decl) };
  }

  private paramsOf(sym: ts.Symbol): string {
    const decl = sym.declarations?.find(
      (d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d),
    );
    return decl ? this.paramsFromDecl(decl) : "";
  }

  private paramsFromDecl(decl: ts.TypeAliasDeclaration | ts.InterfaceDeclaration): string {
    return this.typeParams(decl.typeParameters);
  }

  private typeParams(params: readonly ts.TypeParameterDeclaration[] | undefined): string {
    if (!params?.length) return "";
    const parts = params.map((p) => {
      let s = p.name.text;
      if (p.constraint) s += ` extends ${this.resolve(this.checker.getTypeFromTypeNode(p.constraint), [], 0)}`;
      if (p.default) s += ` = ${this.resolve(this.checker.getTypeFromTypeNode(p.default), [], 0)}`;
      return s;
    });
    return `<${parts.join(", ")}>`;
  }

  private signatureTypeParams(sig: ts.Signature): string {
    const decl = sig.getDeclaration?.();
    return decl?.typeParameters ? this.typeParams(decl.typeParameters) : "";
  }

  private namedSymbol(type: ts.Type): ts.Symbol | undefined {
    const sym = type.aliasSymbol ?? type.getSymbol();
    if (!sym) return undefined;
    const wanted =
      ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class;
    return sym.flags & wanted ? sym : undefined;
  }

  private keepByName(sym: ts.Symbol): boolean {
    const decls = sym.getDeclarations() ?? [];
    if (!decls.some((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()))) return false;
    return decls.some(
      (d) => ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d) || ts.isEnumDeclaration(d),
    );
  }

  private isDeferredMapped(type: ts.Type): boolean {
    return !!(this.objectFlags(type) & ts.ObjectFlags.Mapped) && type.getProperties().length === 0;
  }

  private mappedReadonly(type: ts.Type): boolean {
    if (!(this.objectFlags(type) & ts.ObjectFlags.Mapped)) return false;
    const token = (type as unknown as { declaration?: ts.MappedTypeNode }).declaration?.readonlyToken;
    return !!token && token.kind !== ts.SyntaxKind.MinusToken;
  }

  private aliasArgs(type: ts.Type): readonly ts.Type[] {
    if (type.aliasTypeArguments) return type.aliasTypeArguments;
    return this.refArgs(type);
  }

  private refArgs(type: ts.Type): readonly ts.Type[] {
    if (!(this.objectFlags(type) & ts.ObjectFlags.Reference)) return [];
    return this.checker.getTypeArguments(type as ts.TypeReference);
  }

  private literal(type: ts.Type): string {
    const value = (type as ts.LiteralType).value;
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "object") return `${value.negative ? "-" : ""}${value.base10Value}n`;
    return String(value);
  }

  private stripUndefined(type: ts.Type): ts.Type {
    if (!(type.flags & ts.TypeFlags.Union)) return type;
    const kept = (type as ts.UnionType).types.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
    return kept.length === 1 ? kept[0] : type;
  }

  private propertyName(prop: ts.Symbol): string | null {
    const name = prop.getName();
    const symbolMatch = WELL_KNOWN_SYMBOL.exec(name);
    if (symbolMatch) return WELL_KNOWN_SYMBOLS.has(symbolMatch[1]) ? `[Symbol.${symbolMatch[1]}]` : null;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
    return JSON.stringify(name);
  }

  private isReadonly(prop: ts.Symbol): boolean {
    const byModifier = prop
      .getDeclarations()
      ?.some((d) => !!(ts.getCombinedModifierFlags(d as ts.Declaration) & ts.ModifierFlags.Readonly));
    const byCheckFlag = !!((prop as unknown as { checkFlags?: number }).checkFlags! & CHECK_FLAGS_READONLY);
    return !!byModifier || byCheckFlag;
  }

  private readonlyArray(type: ts.Type): boolean {
    return type.getSymbol()?.name === "ReadonlyArray";
  }

  private wrapArray(inner: string): string {
    return this.hasTopLevelOperator(inner) ? `(${inner})` : inner;
  }

  private hasTopLevelOperator(s: string): boolean {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
      else if (c === ")" || c === "}" || c === "]" || c === ">") depth--;
      else if (depth === 0) {
        if (c === "|" || c === "&") return true;
        if (c === "=" && s[i + 1] === ">") return true;
      }
    }
    return false;
  }

  private print(type: ts.Type): string {
    return this.checker.typeToString(type, undefined, PRINT_FLAGS);
  }
}

const WELL_KNOWN_SYMBOLS = new Set([
  "iterator", "asyncIterator", "hasInstance", "isConcatSpreadable",
  "match", "matchAll", "replace", "search", "species", "split",
  "toPrimitive", "toStringTag", "unscopables",
]);

interface NamedType {
  name: string;
  symbol: ts.Symbol;
  type: ts.Type;
  params: string;
}
