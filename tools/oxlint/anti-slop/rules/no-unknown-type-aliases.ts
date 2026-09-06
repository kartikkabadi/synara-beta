import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  createResolvesToUnknown,
  topLevelAliasDeclarations,
} from "../shared/resolves-to-unknown.ts";

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
    let resolvesToUnknown = createResolvesToUnknown(new Map());

    return {
      Program(node) {
        resolvesToUnknown = createResolvesToUnknown(topLevelAliasDeclarations(node));
        for (const [name, alias] of topLevelAliasDeclarations(node)) {
          if (alias.typeParameters !== null && alias.typeParameters !== undefined) continue;
          if (!resolvesToUnknown(alias.typeAnnotation, new Set([name]))) continue;
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
