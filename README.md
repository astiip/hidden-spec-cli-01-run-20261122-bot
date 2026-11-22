# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/astiip/hidden-spec-cli-01-run-20261122-bot/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/astiip/hidden-spec-cli-01-run-20261122-bot/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and this one tool reads all four to one written contract: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines each edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no file is created, changed, or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 writes the tree and prints one line per changed path (`A`, `D`, `M`, or `R old -> new`) plus `ok: <n> files`. Exit 1 means some edits failed and nothing was written: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`. Exit 2 means the patch itself could not be read: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.

## Matching

An edit's old lines are found at the first of three tiers at which they occur: tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs ignored). A unified hunk takes the occurrence nearest its line number; a SEARCH/REPLACE block needs exactly one; a V4A chunk takes the first at or after its cursor. At tier 2, added lines are re-indented to the file's own indentation, and context lines are always written as the file's own matched lines.

Every edit is all or nothing: edits apply in the patch's order to the tree as earlier edits left it, a failed edit changes nothing and the edits after it still run, and when any edit failed no file is written at all. A changed file keeps its own line break (CRLF or LF) and its final line break, except where a unified hunk's `\ No newline at end of file` line says otherwise; a file an edit creates uses LF and ends with a line break, unless the format says otherwise.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what it did.
- `LICENSE`: MIT.

This entry was built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
