---
name: commit
description: >-
  Splits all uncommitted work into the largest number of human-sized atomic
  git commits and creates them. Each commit is the smallest change a reviewer
  would still accept. Use when the user says /commit, "commit this",
  "commit everything", "commit all uncommitted changes", or "split into
  commits". If the branch's PR was force-pushed or its history rewritten,
  rebuild: redo the full split over the whole PR diff, even if commits were
  already made. Does not push. Skip when the request is message-only.
argument-hint: "[preview]"
---

# Commit

Goal: commit all uncommitted changes, in as many commits as (humanly) possible, as the smallest change commits as possible. Do not push.

If the branch's PR was force-pushed, rebuild the entire split from the PR base (section 2) instead of only slicing the dirty tree.

Empty the working tree into as many **atoms** as a human reviewer would still accept. Then commit them.

An **atom** is the smallest commit that passes the **atom test**: a reviewer who sees only this commit can say what changed, and the tree is not more broken than before.

**Split test:** if half the staged change still passes the atom test, split. Repeat until it fails. That is "as many as humanly possible."

Preview only when the user says `preview`, `dry-run`, or `plan`. Otherwise commit.

Message-only requests ("write a commit message") are out of scope for this skill.

## 0. Message style

Every message follows this style:

- `<type>(<scope>): <imperative summary>` — scope optional
- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`
- Imperative mood: "add", "fix", "remove" — not "added", "adds", "adding"
- 50 chars or fewer when possible, hard cap 72. No trailing period.
- Body only for non-obvious why, breaking changes, migration notes, or linked issues. Wrap at 72 chars, `-` bullets, `Closes #42` / `Refs #17` at the end.
- Never: "This commit does X", "I", "we", "now", "currently", restating what the diff already shows, AI attribution, emoji.

## 1. Gates

Stop if any of these hold:

- Not a git repo (`git rev-parse --show-toplevel` fails)
- Merge or rebase in progress
- User asked for a message only
- Nothing dirty (`git status --porcelain` empty), unless the force-pushed-PR rebuild (section 2) applies

Do not scan home or other repos. Work only in this toplevel.

"Commit what's staged" means split only the index. Default `/commit` means staged + unstaged + untracked (not ignored).

## 2. Force-pushed PR

A force-push on this branch's PR kills the old commit split. /commit detects it on its own; nobody has to say anything. Saying it anyway also works. When detected: redo the full flow over the entire PR diff, whether or not commits were already built, and whether or not the tree is dirty.

Detect (any one fires):

1. Diverged from upstream after fetch:

```bash
git fetch --quiet 2>/dev/null || true
git rev-list --left-right --count HEAD...@{upstream}   # both counts > 0 means rewritten
```

2. GitHub shows a force-push on this PR's timeline and the stack is not already this skill's output:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){timelineItems(last:1,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){totalCount}}}}' -f o=<owner> -f r=<repo> -F p=<number>
```

`totalCount > 0` means the PR head was force-pushed at least once. Query errors (no gh auth, no PR): treat as not detected.

"Already this skill's output" = every subject in `git log --format=%s <base>..HEAD` parses as `type(scope): summary`. The stack is already atomic; skip the rebuild.

No upstream or no PR: skip this section, run the normal flow.

Rebuild:

1. Base: `gh pr view --json baseRefName -q .baseRefName`, else the default branch.
2. Tree dirty: `git stash push -u -m commit-rebuild`.
3. Remote won the rewrite (signal 1): `git reset --hard @{upstream}`. Already synced (signal 2): skip this step.
4. `git reset --soft "$(git merge-base HEAD <base>)"`. The whole PR diff is now staged.
5. `git stash pop`. It refuses or conflicts: stop and report, do not force.
6. `git restore --staged :/`, then continue at section 3 with the whole PR diff as the dirty set.

Commits the rewrite replaced survive in the reflog. Do not merge them back.

This rewrites local history. The skill still never pushes: landing the rebuilt stack takes a force-push the user makes.

## 3. Inventory

Run in parallel:

```bash
git status
git status --porcelain=v1 -uall
git diff
git diff --cached
git log -8 --oneline
```

If the index already mixes concerns, unstage so you can re-slice:

```bash
git restore --staged :/
```

Working tree stays. This is not `git restore :/` and not `git reset --hard`.

Inventory is done when: porcelain list is in hand, both diffs are read, and the index is empty (unless the user said to split only what was staged).

## 4. Build the stack

Cluster dirty paths and hunks into atoms. Apply the split test to each one.

**Keep in one atom** (separating them fails the atom test):

- Manifest + lockfile
- Schema / codegen source + generated output
- Rename (old path + new path)
- Signature / type change + call sites that would not compile without it
- Production change + the test that locks it, when both are dirty

**Split into different atoms:**

- Different Conventional Commit types (`feat` vs `fix` vs `docs` vs `test` vs `chore` vs `refactor` vs `style` vs `perf` vs `ci` vs `build`)
- Unrelated features or bugs
- Mechanical (format, import sort, whitespace) vs behavior
- Independent files
- Docs that are not documenting this atom's change

Order: mechanical first, then dependency order, then the rest.

If a file holds two concerns, read [split.md](split.md) and take hunks. Whole-file add is the default when the file is one concern. Binary files: whole file only.

The stack is done when every dirty path is in exactly one atom or on the secret-skip list. No unclassified path. Split test has been applied to every atom. Write the numbered stack (paths and hunks per atom) before step 6. Do not commit until the stack is done.

## 5. Secrets

Before every commit, read the staged diff.

Leave the path dirty and skip it when:

- The path looks like a secret file (`.env`, `*.pem`, `credentials.json`, `id_rsa`, `*.p12`)
- The diff has key-like values (`BEGIN PRIVATE KEY`, `AWS_SECRET`, `api_key`, `password=`, long tokens)

Report skipped paths. Never print the secret.

## 6. Commit each atom

Stage only that atom's paths or hunks. `git add -- path` for whole files. Never `git add -A`, `git add .`, or `git commit -a`. Never `git add -i` / `git add -p`. Never `--no-verify` or `--no-gpg-sign`. Never amend except the hook case below.

Message per section 0. Then:

```bash
git commit -m "$(cat <<'EOF'
type(scope): imperative summary

optional body
EOF
)"
```

If the hook **rejects**: fix, new commit. Do not amend.

If the hook **succeeds and rewrites files** that belong in this atom, and HEAD is the commit you just made and it is not pushed:

```bash
git add -- <hook-rewritten-paths>
git commit --amend --no-edit
```

That is the only amend this skill uses.

Verify: `git status --porcelain` still contains only later atoms. Then next atom.

## 7. Report

```
**Committed:** N
- `hash` subject
- `hash` subject
**Left dirty:** none | paths
**Stopped:** none | reason
**Rebuilt:** none | force-pushed PR redone from `<base>`
```

Do not push.

## Example

Dirty: `package.json` + lockfile (new lib), `auth.ts` (login + unrelated typo), `auth.test.ts` (login tests), `README.md` (login docs + unrelated typo).

Stack:

1. `chore(deps): add xyz`
2. `fix(auth): correct error string typo`
3. `feat(auth): add login` (login hunks + tests)
4. `docs(auth): mention login`
5. `docs: fix README typo`

Five atoms, not one.
