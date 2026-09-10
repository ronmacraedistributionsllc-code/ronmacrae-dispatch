---
description: Continue the phased build - verify the newest PHASE checkpoint, repair incomplete work, then complete only the focused task the user passes as arguments.
agent: build
subtask: true
---

You are one focused run of a phased build of this repository. The task for this run is:

**$ARGUMENTS**

If the task above is empty, stop and ask the user which task to take on. Do not invent work.

## Hard rules (apply to every step)

- Never inspect the entire repository. Read only: the newest checkpoint, the files it lists as changed, and files inside the module area the task names. No repo-wide listings, greps, or bulk reads.
- Never create giant files. Every new or edited file must be small and single-purpose; prefer several small files over one large file.
- Fix only concrete errors (failing tests, type errors) with the smallest patch. No refactors, no features beyond the task.
- Do not start the next phase or any unrelated work.

## Procedure

1. **Read the newest checkpoint.** List `PHASE*_CHECKPOINT.md` at the repo root and pick the newest (highest phase number; tie → latest modified). Read it fully and note: the last completed task, its commands and results, the files it lists as changed, and its out-of-scope notes. If none exists, this is the first phase: do step 2 only if git is available, then go to step 4.

2. **Inspect the relevant changed files.** If this is a git repository, run `git status` and `git diff` and read only the files relevant to the last completed task. If it is not a git repository, read only the files the checkpoint lists as changed. Read nothing else.

3. **Verify the last completed task.** Re-run the commands in the checkpoint's "Re-verify" section exactly as written.
   - All pass → go to step 5.
   - Any fail → **repair the incomplete work**: fix only the concrete errors with small patches and re-run until green. Never add features to repair.

4. **Complete the focused task** from `$ARGUMENTS`. Implement only that task, following the repository's existing conventions, in small working patches.

5. **Run the relevant checks.** Run the test and type-check commands for the workspace(s) the task touched (from the affected `package.json` scripts; for example in `apps/api`: `npm run test:unit` and `npm run typecheck`). Prefer scoped runs; run a wider suite only if the task touched shared code. Fix any concrete failures they reveal with small patches and re-run until green.

6. **Update the checkpoint.**
   - If the task completed the phase recorded in the newest checkpoint, update that file in place.
   - If the task is a new phase, create `PHASE<N>_<AREA>_CHECKPOINT.md` at the repo root, where `N` is the last phase number + 1 and `AREA` is a short uppercase slug of the task.
   - Write: status, scope, the exact commands with results, fixes applied, out-of-scope notes, and a "Re-verify" block. Keep it factual and under ~100 lines.

7. **Stop.** Report the commands run, their results, and the checkpoint path. Do not continue to further work.
