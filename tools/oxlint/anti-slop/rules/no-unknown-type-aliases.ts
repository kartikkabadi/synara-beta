import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  collectAliasDeclarationsIn,
  createResolvesToUnknown,
  firstWinsAliasDeclarations,
  refineAliasAmbiguity,
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
    let resolvesToUnknown = createResolvesToUnknown(new Map(), new Set());

    return {
      Program(node) {
        const collected = collectAliasDeclarationsIn(node, context.sourceCode.visitorKeys);
        const conservative = createResolvesToUnknown(
          firstWinsAliasDeclarations(collected.declarations),
          collected.ambiguous,
        );
        const refined = refineAliasAmbiguity(
          collected.declarations,
          collected.ambiguous,
          (type, name) => conservative(type, new Set(), new Set([name])),
        );
        resolvesToUnknown = createResolvesToUnknown(refined.aliases, refined.ambiguous);
        for (const [name, list] of collected.declarations) {
          for (const alias of list) {
            const shadowedAliases = lexicalTypeParameterNames(alias, context.sourceCode.visitorKeys);
            if (!resolvesToUnknown(alias.typeAnnotation, shadowedAliases, new Set([name]))) continue;
            context.report({
              node: alias.id,
              messageId: "unknownAlias",
              data: { alias: name },
            });
          }
        }
      },
    };
  },
});
