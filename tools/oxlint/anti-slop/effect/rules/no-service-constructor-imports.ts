import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isProjectLocalImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;
  return specifier.imported.value;
}

function importedModuleStem(source: string): string {
  const segments = source.split(/[\\/]/u).filter(Boolean);
  let base = segments[segments.length - 1] ?? "";
  base = base.replace(/\.[cm]?[jt]sx?$/u, "");
  if (base.toLowerCase() === "index") {
    // ./index.ts re-exports the owning module; fall back to the parent segment
    // only when it is a real name (never "." or "..").
    const parent = segments[segments.length - 2] ?? "";
    if (parent.length > 0 && parent !== "." && parent !== "..") base = parent;
  }
  return base;
}

function namesOwningModule(importedName: string, source: string): boolean {
  const stem = importedName.replace(/^make/u, "").toLowerCase();
  return stem.length > 0 && stem === importedModuleStem(source).toLowerCase();
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-local imports of make<Capability> constructors named after their owning module outside test and spec files.",
    },
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));

    return {
      ImportDeclaration(node) {
        if (isTestFile || !isProjectLocalImport(node.source.value)) return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;

          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;
          if (!namesOwningModule(importedName, node.source.value)) continue;

          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName },
          });
        }
      },
    };
  },
});
