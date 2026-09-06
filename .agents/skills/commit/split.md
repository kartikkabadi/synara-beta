# Hunk splits

Use this when one file fails the split test (two concerns in one file).

Interactive add is forbidden (`git add -p`, `git add -i`). Use a patch.

## Existing file

```bash
git diff -- path/to/file > /tmp/commit-full.patch
cp /tmp/commit-full.patch /tmp/commit-atom.patch
```

Edit `/tmp/commit-atom.patch`: keep the `diff --git` / `---` / `+++` headers and only the `@@` hunks for this atom. Delete the other hunks.

```bash
git apply --cached /tmp/commit-atom.patch
```

If `git apply --cached` fails, do not `--reject` or `--3way` your way into a mess. Keep those hunks in one atom (whole file, or a larger hunk set that applies).

`git diff -U0 -- path` then `git apply --cached --unidiff-zero` is OK when context lines glue two atoms together. Prefer `-U3` first.

## New file (only part of it)

```bash
git add -N -- path/to/file
git diff -- path/to/file > /tmp/commit-full.patch
```

Then the same edit + `git apply --cached`. If the new file is one concern, `git add -- path/to/file` instead.

## Checks

After apply:

```bash
git diff --cached -- path/to/file   # this atom
git diff -- path/to/file            # remainder
```

Both should be non-empty when the file is mixed. If the cached diff still has both concerns, you failed the split.
