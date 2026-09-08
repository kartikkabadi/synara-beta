import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  createScopeIndex,
  createScopedResolvesToUnknown,
  selfAliasVisitKey,
  type ScopeIndex,
  type ScopedResolves,
} from "../shared/resolves-to-unknown.ts";
import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  createOnce(context) {
    let resolvesToUnknown: ScopedResolves = () => false;
    let index: ScopeIndex | null = null;

    return {
      Program(node) {
        index = createScopeIndex(node, context.sourceCode.visitorKeys);
        resolvesToUnknown = createScopedResolvesToUnknown(index);
        for (const alias of index.allAliases()) {
          const name = alias.id.name;
          const shadowedAliases = lexicalTypeParameterNames(alias, context.sourceCode.visitorKeys);
          if (
            !resolvesToUnknown(
              alias,
              alias.typeAnnotation,
              shadowedAliases,
              new Set([selfAliasVisitKey(name)]),
            )
          ) {
            continue;
          }
          context.report({
            node: alias.id,
            messageId: "unknownAlias",
            data: { alias: name },
          });
        }
      },
    };
  },
});
