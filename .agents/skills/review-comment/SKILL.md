---
name: review-comment
description: >-
  Post, update, or reply to line-specific pull request review comments on GitHub.
  Use when the user wants to leave feedback on a PR, mention a CI failure tied to
  a file, reply to an existing review thread, or edit a review comment so it
  sounds like a human reviewer. The skill targets comments attached to specific
  diff lines, not top-level PR issue comments.
argument-hint: "[pr-url]"
---

# Review comment

Goal: leave clear, line-specific pull request review comments that read like a human reviewer wrote them — with a "thanks", concrete evidence, and a concrete ask.

## When to use

- The user asks to post a review comment, leave line feedback, reply to a review thread, or update an existing review comment.
- The feedback is tied to a specific file and line(s) in a PR diff, not a general PR-level comment.
- The user wants the comment to include CI findings, real fixtures, or brand-casing examples.

## What it is

This is a **pull request review comment** (also called an **inline review comment**). It appears on the *Files changed* tab and is attached to a specific diff hunk. It is different from:
- a top-level **PR issue comment** (conversation tab), or
- a **review summary** (the `pullrequestreview-...` object that can hold many line comments).

The body is GitHub-flavored Markdown. Use single backticks for short identifiers and snippets; triple backticks only for multi-line blocks.

## Authentication

- Check `gh auth status` first. If it is not green, re-register with the keyring token without printing the value:

  ```bash
  gh auth token -h github.com -u <github-username> 2>/dev/null | gh auth login --with-token
  ```

- Prefer the `gh` CLI for creating and editing comments. The GitHub MCP server can add replies (`add_reply_to_pull_request_comment`) but cannot edit an existing review comment.
- Never print, quote, or paste a token in the final reply.

## Workflow

1. **Identify the target.**
   - Get the PR diff for the file: `gh api /repos/{owner}/{repo}/pulls/{number}/files` and read the `patch`.
   - Map the code location to the RIGHT-side line numbers of the new diff hunk.
   - Check for an existing review comment on the same lines: `gh api /repos/{owner}/{repo}/pulls/{number}/comments`. The comment `id` is the number after `#discussion_r`.

2. **Write the body like a reviewer, not a status report.**
   - Open with thanks and what is right about the PR.
   - Explain the specific regression or concern, quoting the code with inline backticks.
   - Give real evidence: a fixture, a discovered model name, a CI failure, or a local reproduction.
   - State the user-visible effect, not only the code behavior.
   - Close with a question or a concrete suggestion.

3. **Post or update.**
   - New line comment:

     ```bash
     gh api -X POST /repos/{owner}/{repo}/pulls/{number}/comments \
       -f path="apps/web/src/providerModelOptions.ts" \
       -f line=175 \
       -f start_line=174 \
       -f side=RIGHT \
       -f start_side=RIGHT \
       -f body="Thank you for the PR..."
     ```

   - Update an existing line comment (JSON body avoids quoting issues):

     ```bash
     jq -n --arg body "$body" '{body: $body}' | \
       gh api -X PATCH /repos/{owner}/{repo}/pulls/comments/{id} --input -
     ```

4. **Verify.**
   - Fetch the comment: `gh api /repos/{owner}/{repo}/pulls/comments/{id}`.
   - Open the `html_url` and confirm the text, line range, and formatting.

## Style

- No meta-phrases like "Verified." or "I checked the code and..."
- One concern per comment.
- Use the user's own file and symbol names; do not invent paths.
- If CI is failing on the same file, mention it in a separate paragraph and give the exact step and the fix command.

## Example

```
Thank you for the PR. The `glm` and `deepseek` casing fixes are right, but `rawNameIsIdentifier` looks like it will regress provider-branded names that aren't in `MODEL_TOKEN_DISPLAY_NAMES`.

OpenCode serves `opencode/minimax-m2.5-free` with `name: "MiniMax M2.5 Free"`. With this check, `modelDisplayIdentity("MiniMax M2.5 Free")` equals `modelDisplayIdentity("minimax-m2.5-free")`, so the provider-supplied name is discarded and the fallback is `humanizeModelSlug`. That function only restores casing for `deepseek` and `glm`, so `minimax` becomes `Minimax` and the rendered label is `Minimax M2.5 Free` — losing the brand casing.

Same issue clobbers `kimi-for-coding/k2p6` with `name: "K2P6"` → `K2p6`.

Also, `Static Checks (fast)` is failing on the `Format` step (`bun run fmt:check` / `oxfmt --check`). It flags formatting in 3 files: `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`, `apps/web/src/providerModelOptions.ts`, and `packages/shared/src/model.ts`. Running `bun run fmt` will fix the import/chain indentation.

Could we keep the provider's exact casing when the raw name is only a casing/separator variant, or expand the token table to cover `minimax`, `kimi`, and other provider brands discovery is known to return?
```

## Caveats

- `gh auth status` must be green before any `gh api` or `gh pr` call.
- Do not read or expose tokens. Use the keyring re-register flow above.
- The GitHub MCP server can add a reply to an existing review comment but cannot `PATCH` an existing one; use `gh` for edits.
- A comment that needs a line range must pass both `line` and `start_line` with matching `side` and `start_side`.
