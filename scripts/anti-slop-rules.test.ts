// FILE: anti-slop-rules.test.ts
// Purpose: Runs the anti-slop rules through real oxlint on fixture files so each
//          rule's detections and false-positive guards are verified end to end.
// Layer: Local developer tooling

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oxlintBinary = resolve(repoRoot, "node_modules/.bin/oxlint");
const pluginRoot = resolve(repoRoot, "tools/oxlint/anti-slop");

interface OxlintDiagnostic {
  code: string;
  filename: string;
}

function runRules(
  files: Record<string, string>,
  rules: Record<string, string>,
): Map<string, string[]> {
  const dir = mkdtempSync(join(tmpdir(), "anti-slop-rules-"));
  try {
    const config = {
      jsPlugins: [
        { name: "anti-slop", specifier: join(pluginRoot, "index.ts") },
        { name: "anti-slop-effect", specifier: join(pluginRoot, "effect", "index.ts") },
      ],
      rules,
    };
    writeFileSync(join(dir, ".oxlintrc.json"), `${JSON.stringify(config, null, 2)}\n`);
    const paths: string[] = [];
    for (const [name, source] of Object.entries(files)) {
      const path = join(dir, name);
      writeFileSync(path, source);
      paths.push(path);
    }
    const shell = process.platform === "win32";
    const command = shell ? `"${oxlintBinary}.cmd"` : oxlintBinary;
    const quoteForShell = (value: string) => (shell ? `"${value}"` : value);
    const result = spawnSync(
      command,
      [
        "-f",
        "json",
        "--config",
        quoteForShell(join(dir, ".oxlintrc.json")),
        ...paths.map(quoteForShell),
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26, shell },
    );
    if (!result.stdout) {
      throw new Error(`oxlint produced no JSON output (status ${result.status})`);
    }
    // SAFETY: test fixture parses well-formed oxlint JSON output and filters by requested rule codes.
    const output = JSON.parse(result.stdout) as { diagnostics?: OxlintDiagnostic[] };
    const requestedCodes = new Set(Object.keys(rules).map((rule) => `${rule.replace("/", "(")})`));
    const byFile = new Map<string, string[]>();
    for (const diagnostic of output.diagnostics ?? []) {
      if (!requestedCodes.has(diagnostic.code)) continue;
      const name = diagnostic.filename.startsWith(dir)
        ? diagnostic.filename.slice(dir.length + 1)
        : diagnostic.filename;
      const codes = byFile.get(name) ?? [];
      codes.push(diagnostic.code);
      byFile.set(name, codes);
    }
    return byFile;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("no-module-mocking", () => {
  it("reports namespace-import mocking like direct vi imports", () => {
    const byFile = runRules(
      {
        "namespace.ts":
          'import * as vitest from "vitest";\nvitest.vi.mock("./seam", () => ({}));\n',
        "direct.ts": 'import { vi } from "vitest";\nvi.mock("./seam", () => ({}));\n',
      },
      { "anti-slop/no-module-mocking": "error" },
    );
    expect(byFile.get("namespace.ts")).toEqual(["anti-slop(no-module-mocking)"]);
    expect(byFile.get("direct.ts")).toEqual(["anti-slop(no-module-mocking)"]);
  });

  it("reports jest.setMock like the other mocking entry points", () => {
    const byFile = runRules(
      {
        "setmock.ts": "jest.setMock('./dep', {});\n",
        "control.ts": "jest.fn();\n",
      },
      { "anti-slop/no-module-mocking": "error" },
    );
    expect(byFile.get("setmock.ts")).toEqual(["anti-slop(no-module-mocking)"]);
    expect(byFile.get("control.ts")).toBeUndefined();
  });
});

describe("no-conditional-empty-object-spread", () => {
  it("reports parenthesized empty-object branches", () => {
    const byFile = runRules(
      {
        "parens.ts": "const cond = false;\nexport const x = { ...(cond ? ({}) : { a: 1 }) };\n",
        "plain.ts": "const cond = false;\nexport const x = { ...(cond ? {} : { a: 1 }) };\n",
        "asserted.ts":
          "const cond = false;\nexport const x = { ...(cond ? ({} as object) : { a: 1 }) };\n",
      },
      { "anti-slop/no-conditional-empty-object-spread": "error" },
    );
    expect(byFile.get("parens.ts")).toEqual(["anti-slop(no-conditional-empty-object-spread)"]);
    expect(byFile.get("plain.ts")).toEqual(["anti-slop(no-conditional-empty-object-spread)"]);
    expect(byFile.get("asserted.ts")).toEqual(["anti-slop(no-conditional-empty-object-spread)"]);
  });
});

describe("reflect rules", () => {
  it("reports Reflect through parentheses and type assertions", () => {
    const byFile = runRules(
      {
        "paren.ts":
          "export function f(target: object) {\n  return (Reflect).get(target, 'k');\n}\n",
        "asserted.ts":
          "export function g(target: object) {\n  return (Reflect as typeof Reflect).apply(Object.keys, target, []);\n}\n",
        "direct.ts": "export function h(target: object) {\n  return Reflect.get(target, 'k');\n}\n",
      },
      { "anti-slop/no-reflect-get": "error", "anti-slop/no-reflect-apply": "error" },
    );
    expect(byFile.get("paren.ts")).toEqual(["anti-slop(no-reflect-get)"]);
    expect(byFile.get("asserted.ts")).toEqual(["anti-slop(no-reflect-apply)"]);
    expect(byFile.get("direct.ts")).toEqual(["anti-slop(no-reflect-get)"]);
  });
});

describe("no-unknown-type-aliases", () => {
  it("reports aliases whose union contains unknown", () => {
    const byFile = runRules(
      {
        "union.ts": "export type Value = string | unknown;\n",
        "clean.ts": "export type Value = string;\n",
      },
      { "anti-slop/no-unknown-type-aliases": "error" },
    );
    expect(byFile.get("union.ts")).toEqual(["anti-slop(no-unknown-type-aliases)"]);
    expect(byFile.get("clean.ts")).toBeUndefined();
  });

  it("does not report nested aliases whose body references a shadowing type parameter", () => {
    const byFile = runRules(
      {
        "local-param-shadow.ts":
          "type Mysterious = unknown;\nexport function outer<Mysterious>() {\n  type Inner = Mysterious;\n  return function inner(input: Inner) { return input; };\n}\n",
      },
      { "anti-slop/no-unknown-type-aliases": "error" },
    );
    expect(byFile.get("local-param-shadow.ts")).toEqual(["anti-slop(no-unknown-type-aliases)"]);
  });
});

describe("no-unknown-parameters", () => {
  it("reports parenthesized and union unknown annotations without flagging type parameters", () => {
    const byFile = runRules(
      {
        "paren.ts": "export function f(input: (unknown)) { return input; }\n",
        "union.ts": "export function g(input: unknown | string) { return input; }\n",
        "alias.ts":
          "type Mysterious = unknown;\nexport function h(input: Mysterious) { return input; }\n",
        "generic.ts": "export function t<T>(input: T) { return input; }\n",
        "cause.ts": "export function e(cause: unknown) { return cause; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    const reported = ["anti-slop(no-unknown-parameters)"];
    expect(byFile.get("paren.ts")).toEqual(reported);
    expect(byFile.get("union.ts")).toEqual(reported);
    expect(byFile.get("alias.ts")).toEqual(reported);
    expect(byFile.get("generic.ts")).toBeUndefined();
    expect(byFile.get("cause.ts")).toBeUndefined();
  });

  it("does not let aliases inside a top-level block leak into module scope", () => {
    const byFile = runRules(
      {
        "block.ts":
          "{\n  type Mysterious = unknown;\n}\nexport function f(value: Mysterious) { return value; }\n",
        "shadowed.ts":
          "type Mysterious = unknown;\nexport function f(value: Mysterious) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("block.ts")).toBeUndefined();
    expect(byFile.get("shadowed.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("does not report parameters whose alias is shadowed by a nested alias", () => {
    const byFile = runRules(
      {
        "nested-shadow.ts":
          "type Mysterious = unknown;\nexport function outer() {\n  type Mysterious = string;\n  return function inner(input: Mysterious) { return input; };\n}\n",
        "top-level.ts":
          "type Mysterious = unknown;\nexport function inner(input: Mysterious) { return input; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("nested-shadow.ts")).toBeUndefined();
    expect(byFile.get("top-level.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("keeps same-name aliases resolvable when every declaration resolves alike", () => {
    const byFile = runRules(
      {
        "same-name-agree.ts":
          "type Mysterious = unknown;\nexport function outer() {\n  type Mysterious = unknown;\n  return function inner(input: Mysterious) { return input; };\n}\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("same-name-agree.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("resolves generic alias arguments including unknown", () => {
    const byFile = runRules(
      {
        "generic-arg.ts":
          "type Box<T> = T;\nexport function f(value: Box<unknown>) { return value; }\n",
        "typed-arg.ts":
          "type Box<T> = T;\nexport function g(value: Box<string>) { return value; }\n",
        "defaulted.ts":
          "type Defaulted<T = unknown> = T;\nexport function h(value: Defaulted) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    const reported = ["anti-slop(no-unknown-parameters)"];
    expect(byFile.get("generic-arg.ts")).toEqual(reported);
    expect(byFile.get("typed-arg.ts")).toBeUndefined();
    expect(byFile.get("defaulted.ts")).toEqual(reported);
  });

  it("resolves forwarded parameters through nested generic aliases without looping", () => {
    const byFile = runRules(
      {
        "forwarded.ts":
          "type Inner<T> = T;\ntype Outer<T> = Inner<T>;\nexport function f(value: Outer<unknown>) { return value; }\n",
        "typed-forward.ts":
          "type Inner<T> = T;\ntype Outer<T> = Inner<T>;\nexport function g(value: Outer<string>) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    const reported = ["anti-slop(no-unknown-parameters)"];
    expect(byFile.get("forwarded.ts")).toEqual(reported);
    expect(byFile.get("typed-forward.ts")).toBeUndefined();
  });

  it("treats a local Promise alias as the alias, not the built-in wrapper", () => {
    const byFile = runRules(
      {
        "promise-alias.ts":
          "type Promise<T> = { value: T };\nexport function f(value: Promise<unknown>) { return value; }\n",
        "built-in.ts": "export function g(value: Promise<unknown>) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("promise-alias.ts")).toBeUndefined();
    expect(byFile.get("built-in.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("treats a local Promise interface and import as shadowed", () => {
    const byFile = runRules(
      {
        "promise-interface.ts":
          "interface Promise<T> { value: T }\nexport function f(value: Promise<unknown>) { return value; }\n",
        "promise-import.ts":
          "import { Promise } from './external';\nexport function f(value: Promise<unknown>) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("promise-interface.ts")).toBeUndefined();
    expect(byFile.get("promise-import.ts")).toBeUndefined();
  });

  it("treats a named class expression's name as scoped to its own body", () => {
    const byFile = runRules(
      {
        "class-expression.ts":
          "const C = class Promise {\n  m(input: Promise<unknown>) { return input; }\n};\nexport function f(value: Promise<unknown>) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    // Inside the class body `Promise` is the local class; outside it the name
    // is invisible and the built-in wrapper resolves to unknown.
    expect(byFile.get("class-expression.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("does not resolve a named class expression's name to an outer alias inside its body", () => {
    const byFile = runRules(
      {
        "class-alias-shadow.ts":
          "type T = unknown;\nconst C = class T {\n  m(input: T) { return input; }\n};\nexport function f(value: T) { return value; }\n",
        "control.ts":
          "type T = unknown;\nexport function f(input: T) { return input; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    // Inside the class body `T` is the class itself, so the parameter use must
    // not be reported; outside it the outer alias resolves to unknown. Before
    // the lookup stopped at the class binding, the in-body use was reported
    // through the outer alias and this file produced two diagnostics.
    expect(byFile.get("class-alias-shadow.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
    expect(byFile.get("control.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("does not report parameters whose alias is shadowed by a nested interface", () => {
    const byFile = runRules(
      {
        "interface-shadow.ts":
          "type Mysterious = unknown;\nexport function outer() {\n  interface Mysterious { id: string }\n  return function inner(input: Mysterious) { return input; };\n}\n",
        "control.ts":
          "type Mysterious = unknown;\nexport function inner(input: Mysterious) { return input; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    // Inside `outer` the name `Mysterious` is the local interface, so the
    // parameter is not unknown; the control without the interface reports.
    expect(byFile.get("interface-shadow.ts")).toBeUndefined();
    expect(byFile.get("control.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("resolves generic defaults that reference earlier type parameters", () => {
    const byFile = runRules(
      {
        "sibling-default.ts":
          "type Defaulted<T = unknown, U = T> = U;\nexport function f(value: Defaulted) { return value; }\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("sibling-default.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });
});

describe("no-unsafe-dictionary-type", () => {
  it("still suppresses bare uses of non-generic aliases", () => {
    const byFile = runRules(
      {
        "plain-alias.ts": "type Safe = Record<string, string>;\nexport let s: Safe = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("plain-alias.ts")).toBeUndefined();
  });

  it("flags bare uses of generic aliases whose default is unsafe", () => {
    const byFile = runRules(
      {
        "generic-default.ts":
          "type Dict<T = unknown> = Record<string, T>;\nexport let d: Dict = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("generic-default.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("does not let an outer alias shadow a generic parameter when checking the alias body", () => {
    const byFile = runRules(
      {
        // The outer alias must be a safe value: if a resolution bug consulted
        // it inside Dict's body, the body would classify as string (no report)
        // and this expectation would fail. With the shared `unknown` the two
        // paths were indistinguishable.
        "outer-shadow.ts":
          "type T = string;\ntype Dict<T = unknown> = Record<string, T>;\nexport let d: Dict = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("outer-shadow.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("sees type aliases declared inside functions", () => {
    const byFile = runRules(
      {
        "nested-alias.ts":
          "export function f() {\n  type Params = Record<string, unknown>;\n  let p: Params = {};\n  return p;\n}\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("nested-alias.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("does not let nested declarations shadow built-ins for top-level uses", () => {
    const byFile = runRules(
      {
        "nested-record.ts":
          "export function f() {\n  type Record = { id: string };\n  let p: Record = { id: 'a' };\n  return p;\n}\nexport let q: Record<string, unknown> = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("nested-record.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("resolves generic interface dictionaries instantiated with unsafe values", () => {
    const byFile = runRules(
      {
        "generic-interface.ts":
          "interface Box<T> { [key: string]: T }\nexport let b: Box<unknown> = {};\nexport let safe: Box<string> = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("generic-interface.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("resolves generic interface extends with different parameter names", () => {
    const byFile = runRules(
      {
        "mismatched-interface.ts":
          "interface Base<T> { [key: string]: T }\ninterface Box<U> extends Base<U> {}\nexport let b: Box<unknown> = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("mismatched-interface.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("resolves aliases in Record value position", () => {
    const byFile = runRules(
      {
        "alias-value.ts": "type M = unknown;\nexport let d: Record<string, M> = {};\n",
        "nested-alias-value.ts":
          "export function f() {\n  type M = unknown;\n  let d: Record<string, M> = {};\n  return d;\n}\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("alias-value.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
    expect(byFile.get("nested-alias-value.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("resolves generic defaults that reference earlier type parameters", () => {
    const byFile = runRules(
      {
        "sibling-default.ts":
          "type F<T, U = T> = Record<string, U>;\nexport let x: F<unknown> = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("sibling-default.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("treats imported built-in names as shadowed regardless of import kind", () => {
    const byFile = runRules(
      {
        "imported-record.ts":
          'import { Record } from "./record";\nexport let r: Record<string, unknown> = {};\n',
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("imported-record.ts")).toBeUndefined();
  });
});

describe("no-unknown-returns", () => {
  it("does not treat infers from nested conditional branches as outer binders", () => {
    const byFile = runRules(
      {
        "infer-shadow.ts":
          "type Alias = unknown;\nexport type Wrapper<T> = T extends (U extends infer Alias ? string : never) ? { m(): Alias } : never;\n",
        "control.ts":
          "type Alias = unknown;\nexport function f(): Alias { return null as never; }\n",
      },
      { "anti-slop/no-unknown-returns": "error" },
    );
    expect(byFile.get("infer-shadow.ts")).toEqual(["anti-slop(no-unknown-returns)"]);
    expect(byFile.get("control.ts")).toEqual(["anti-slop(no-unknown-returns)"]);
  });
});

describe("no-widen-then-assert", () => {
  it("treats file-declared Record built-in names as shadowed", () => {
    const byFile = runRules(
      {
        "shadowed.ts":
          'type PropertyKey = "id" | "name";\nexport function f() {\n  const r: Record<PropertyKey, unknown> = { id: 1, name: 2 };\n  return r as { id: number };\n}\n',
        "builtin.ts":
          "export function f() {\n  const r: Record<PropertyKey, unknown> = { id: 1, name: 2 };\n  return r as { id: number };\n}\n",
      },
      { "anti-slop/no-widen-then-assert": "error" },
    );
    expect(byFile.get("shadowed.ts")).toBeUndefined();
    expect(byFile.get("builtin.ts")).toEqual(["anti-slop(no-widen-then-assert)"]);
  });

  it("does not treat value-only function declarations as type shadowing", () => {
    const byFile = runRules(
      {
        "value-fn.ts":
          "function Record() { return 1; }\nexport function f() {\n  const r: Record<PropertyKey, unknown> = { id: 1, name: 2 };\n  return r as { id: number };\n}\n",
      },
      { "anti-slop/no-widen-then-assert": "error" },
    );
    expect(byFile.get("value-fn.ts")).toEqual(["anti-slop(no-widen-then-assert)"]);
  });

  it("does not treat nested Record aliases as the built-in Record", () => {
    const byFile = runRules(
      {
        "nested-record.ts":
          "export function f() {\n  type Record<K, V> = { id: string };\n  const r: Record<string, unknown> = { id: 'a' };\n  return r as { id: string };\n}\n",
        "nested-key.ts":
          'export function f() {\n  type PropertyKey = "id";\n  const r: Record<PropertyKey, unknown> = { id: 1 };\n  return r as { id: number };\n}\n',
      },
      { "anti-slop/no-widen-then-assert": "error" },
    );
    expect(byFile.get("nested-record.ts")).toBeUndefined();
    expect(byFile.get("nested-key.ts")).toBeUndefined();
  });
});

describe("no-known-value-widening", () => {
  it("reports one diagnostic when a broad annotation wraps a broad assertion", () => {
    const byFile = runRules(
      {
        "dedup.ts": "export const x: unknown = { a: 1 } as unknown;\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("dedup.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });

  it("reports nested broad assertions exactly once", () => {
    const byFile = runRules(
      {
        "nested-assert.ts":
          "export function f() {\n  const value = { a: 1 };\n  const x: unknown = value as unknown as unknown;\n  return x;\n}\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("nested-assert.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });

  it("reports a non-null-asserted widening exactly once", () => {
    const byFile = runRules(
      {
        "non-null-assert.ts":
          "export function f() {\n  const value = { a: 1 };\n  const x: unknown = (value as unknown)!;\n  return x;\n}\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("non-null-assert.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });

  it("does not flag finite mapped-type annotations", () => {
    const byFile = runRules(
      {
        "finite-mapped.ts":
          'export const x: { [K in "id" | "name"]: string } = { id: "a", name: "b" };\n',
        "open-record.ts": "export const y: Record<string, string> = { a: 'b' };\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("finite-mapped.ts")).toBeUndefined();
    expect(byFile.get("open-record.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });
});

describe("no-shape-in-symbol-names", () => {
  it("reports declared names but not property accesses or import references", () => {
    const byFile = runRules(
      {
        "declared.ts": "const shape = 1;\nexport const x = shape;\n",
        "access.ts": "declare const box: { radius: number };\nexport const s = box.shape;\n",
        "import-ref.ts": "import { shape } from 'geometry';\nexport const s = shape;\n",
        "substring.ts": "export const reshape = (value: string) => value;\n",
        "literal-key.ts": "export const box = { shape: 'round' };\n",
        "destructure-rename.ts":
          "declare const box: Record<string, number>;\nexport const s = box;\nconst { shape: sides } = box;\nexport const n = sides;\n",
      },
      { "anti-slop/no-shape-in-symbol-names": "error" },
    );
    const reported = ["anti-slop(no-shape-in-symbol-names)"];
    expect(byFile.get("declared.ts")).toEqual(reported);
    expect(byFile.get("access.ts")).toBeUndefined();
    expect(byFile.get("import-ref.ts")).toBeUndefined();
    expect(byFile.get("substring.ts")).toEqual(reported);
    expect(byFile.get("literal-key.ts")).toBeUndefined();
    expect(byFile.get("destructure-rename.ts")).toBeUndefined();
  });

  it("reports signature parameters in function and constructor types", () => {
    const byFile = runRules(
      {
        "function-type.ts": "export type Handler = (shape: string) => void;\n",
        "constructor-type.ts": "export type Maker = new (shape: string) => object;\n",
      },
      { "anti-slop/no-shape-in-symbol-names": "error" },
    );
    const reported = ["anti-slop(no-shape-in-symbol-names)"];
    expect(byFile.get("function-type.ts")).toEqual(reported);
    expect(byFile.get("constructor-type.ts")).toEqual(reported);
  });

  it("reports declare-function names and destructured binding values", () => {
    const byFile = runRules(
      {
        "declare-fn.ts": "declare function shape(input: string): string;\n",
        "destructure.ts": "const { source: shape } = { source: 1 };\nexport const x = shape;\n",
        "array-destructure.ts": "const [shape] = [1];\nexport const x = shape;\n",
        "key-rename.ts":
          "declare const values: unknown;\nconst { shape: renamed } = values;\nexport const x = renamed;\n",
      },
      { "anti-slop/no-shape-in-symbol-names": "error" },
    );
    const reported = ["anti-slop(no-shape-in-symbol-names)"];
    expect(byFile.get("declare-fn.ts")).toEqual(reported);
    expect(byFile.get("destructure.ts")).toEqual(reported);
    expect(byFile.get("array-destructure.ts")).toEqual(reported);
    expect(byFile.get("key-rename.ts")).toBeUndefined();
  });

  it("reports private field declarations and catch bindings but not private reads", () => {
    const byFile = runRules(
      {
        "private-field.ts": "class Box {\n  #shape = 1;\n  read() { return this.#shape; }\n}\n",
        "catch-binding.ts":
          "export function f() {\n  try {\n    return 1;\n  } catch (shape) {\n    return shape;\n  }\n}\n",
      },
      { "anti-slop/no-shape-in-symbol-names": "error" },
    );
    const reported = ["anti-slop(no-shape-in-symbol-names)"];
    expect(byFile.get("private-field.ts")).toEqual(reported);
    expect(byFile.get("catch-binding.ts")).toEqual(reported);
  });
});

describe("no-object-parameters", () => {
  it("sees local object aliases, not just top-level ones", () => {
    const byFile = runRules(
      {
        "top-level.ts":
          "type LocalObject = object;\nexport function f(input: LocalObject) { return input; }\n",
        "nested-alias.ts":
          "export function outer() {\n  type LocalObject = object;\n  return function inner(input: LocalObject) { return input; };\n}\n",
        "clean.ts": "export function g(input: string) { return input; }\n",
      },
      { "anti-slop/no-object-parameters": "error" },
    );
    const reported = ["anti-slop(no-object-parameters)"];
    expect(byFile.get("top-level.ts")).toEqual(reported);
    expect(byFile.get("nested-alias.ts")).toEqual(reported);
    expect(byFile.get("clean.ts")).toBeUndefined();
  });

  it("resolves generic object aliases including defaults and arguments", () => {
    const byFile = runRules(
      {
        "generic-default.ts":
          "type Broad<T = object> = T;\nexport function f(input: Broad) { return input; }\n",
        "generic-arg.ts":
          "type Identity<T> = T;\nexport function g(input: Identity<object>) { return input; }\n",
        "typed-arg.ts":
          "type Identity<T> = T;\nexport function h(input: Identity<string>) { return input; }\n",
      },
      { "anti-slop/no-object-parameters": "error" },
    );
    const reported = ["anti-slop(no-object-parameters)"];
    expect(byFile.get("generic-default.ts")).toEqual(reported);
    expect(byFile.get("generic-arg.ts")).toEqual(reported);
    expect(byFile.get("typed-arg.ts")).toBeUndefined();
  });

  it("resolves generic defaults that reference earlier type parameters", () => {
    const byFile = runRules(
      {
        "sibling-default.ts":
          "type Broad<T = object, U = T> = U;\nexport function f(input: Broad) { return input; }\n",
      },
      { "anti-slop/no-object-parameters": "error" },
    );
    expect(byFile.get("sibling-default.ts")).toEqual(["anti-slop(no-object-parameters)"]);
  });
});

describe("scope and substitution regression", () => {
  it("resolves index signatures from extended generic interfaces", () => {
    const byFile = runRules(
      {
        "extends.ts":
          "interface Base<T> { [key: string]: T; }\ninterface Box<T> extends Base<T> {}\nexport let b: Box<unknown> = {};\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    expect(byFile.get("extends.ts")).toEqual(["anti-slop(no-unsafe-dictionary-type)"]);
  });

  it("resolves mapped-type key aliases", () => {
    const byFile = runRules(
      {
        "key-alias.ts": "type Key = string;\nexport const x: { [K in Key]: unknown } = { a: 1 };\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("key-alias.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });

  it("flags local aliases used as widening targets", () => {
    const byFile = runRules(
      {
        "local-alias.ts":
          "export function f() {\n  type Broad = Record<string, unknown>;\n  const x: Broad = { a: 1 };\n  return x;\n}\n",
      },
      { "anti-slop/no-known-value-widening": "error" },
    );
    expect(byFile.get("local-alias.ts")).toEqual(["anti-slop(no-known-value-widening)"]);
  });

  it("resolves nested generic aliases through consumer references", () => {
    const byFile = runRules(
      {
        "nested-consumer.ts":
          "export function f() {\n  type Box<T> = Record<string, T>;\n  type Params = Box<unknown>;\n  let p: Params = {};\n  return p;\n}\n",
      },
      { "anti-slop/no-unsafe-dictionary-type": "error" },
    );
    const reported = byFile.get("nested-consumer.ts") ?? [];
    expect(reported).toContain("anti-slop(no-unsafe-dictionary-type)");
    expect(reported.length).toBeLessThanOrEqual(2);
  });

  it("resolves generic alias arguments from the caller scope", () => {
    const byFile = runRules(
      {
        "caller-scope.ts":
          "type Box<T> = T;\nexport function f() {\n  type Arg = unknown;\n  return function inner(value: Box<Arg>) { return value; };\n}\n",
      },
      { "anti-slop/no-unknown-parameters": "error" },
    );
    expect(byFile.get("caller-scope.ts")).toEqual(["anti-slop(no-unknown-parameters)"]);
  });

  it("does not treat a same-scope Record alias as the built-in Record", () => {
    const byFile = runRules(
      {
        "shadow-record.ts":
          'type Record<A, B> = { id: string };\nconst r: Record<string, unknown> = { id: "a" };\nexport const result = r as { id: string };\n',
      },
      { "anti-slop/no-widen-then-assert": "error" },
    );
    expect(byFile.get("shadow-record.ts")).toBeUndefined();
  });
});

describe("no-service-constructor-imports", () => {
  it("flags only make constructors named after their owning Layers module", () => {
    const byFile = runRules(
      {
        "foreign-factory.ts":
          'import { makeSocketUrl } from "../wsTransport";\nexport const u = makeSocketUrl(null, "/ws");\n',
        "owning-module.ts":
          "import { makeWsDeviceHandlers } from './device/Layers/wsDeviceHandlers';\nexport const h = makeWsDeviceHandlers({});\n",
        "outside-layers.ts":
          "import { makeWsDeviceHandlers } from './device/wsDeviceHandlers';\nexport const h = makeWsDeviceHandlers({});\n",
        "type-only.ts":
          "import type { makeWsDeviceHandlers } from './device/Layers/wsDeviceHandlers';\nexport type H = typeof makeWsDeviceHandlers;\n",
      },
      { "anti-slop-effect/no-service-constructor-imports": "error" },
    );
    expect(byFile.get("foreign-factory.ts")).toBeUndefined();
    expect(byFile.get("owning-module.ts")).toEqual([
      "anti-slop-effect(no-service-constructor-imports)",
    ]);
    expect(byFile.get("outside-layers.ts")).toBeUndefined();
    expect(byFile.get("type-only.ts")).toBeUndefined();
  });
});
