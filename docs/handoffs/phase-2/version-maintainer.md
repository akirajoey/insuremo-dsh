# Phase 2 Version Maintainer Handoff

## Functional commit chain

`128d28e1a3e7786895116061eb9ea460565ed58d` 是 Phase 2 functional HEAD；handoff docs 还会新增一个 commit，最终 release HEAD 必须在提交 handoff 后动态读取，不得硬编码 functional HEAD。

| Task | Full commit SHA |
| --- | --- |
| TASK-008 | `4046a4aaca3180f38660ba3d3687c3eab9b51543` |
| TASK-009 | `0cf37a942c7ebded21476d7edcd34307d3f4f3c0` |
| TASK-010 | `c81b990d198c243373d80a6d7a0e912e2e276d50` |
| TASK-011 | `a6e380786e41ef3f0f2f898bdc71c25d347c5480` |
| TASK-012 | `08f0f3226b1487ae8249d7b79b749db48f435154` |
| TASK-013 | `e64988a8636b928fecef8d28f6267993ddb02867` |
| TASK-014 | `c8e231cf59bfcb462ff1a5bd491cdbbe086e4b1c` |
| TASK-015 | `ab6999041fadad1fe33ce90299162dbdbcaa861e` |
| TASK-016 | `128d28e1a3e7786895116061eb9ea460565ed58d` |

## Handoff-time snapshot

- Branch: `main`
- Functional HEAD: `128d28e1a3e7786895116061eb9ea460565ed58d`
- Worktree was clean before handoff materialization.
- Remote: `https://github.com/akirajoey/insuremo-dsh`
- `origin/main` was Phase 1 `cd4207ce03e70631fed9811a1dd5038e1c753e77`.
- These facts are a snapshot only; release execution must re-check every ref and worktree state.

## Release preflight

1. Handoff docs are committed by version_maintainer after verifier PASS.
2. Run `git fetch --prune origin`.
3. Confirm worktree clean and current branch `main`.
4. Resolve final release HEAD dynamically with `git rev-parse HEAD`.
5. Confirm fetched remote `main` is still the expected Phase 1 head; if it changed, STOP and report—never overwrite.
6. Confirm Phase 2 release chain contains nine functional commits plus the handoff docs commit.
7. Run final configured secret/body scan over the release diff.
8. Confirm Harness repository remains untouched and is never part of the push.

## GitHub credential and push flow

- Check `gh auth status`; existing HTTPS Git credential helper is used. Do not inject PAT/token into commands or files.
- Push only with `git push origin main`; never force-push.
- If network interruption occurs, first inspect `git ls-remote --heads origin main`. A repeated fast-forward push is safe only when the remote has not diverged.
- After push, verify both `git ls-remote --heads origin main` and fetched `origin/main` equal the dynamic release HEAD.
- Report `[PHASE_RELEASE_RESULT]` with release HEAD, commit range and remote verification.

## Recovery rules

- Failure before push leaves the remote unchanged.
- Timeout/interruption requires remote inspection before retry.
- Unexpected remote advancement means STOP; do not reset, revert or force without planner decision.
- Published history is corrected only through a new commit approved by planner, never history rewriting.
- Never push or modify `/Users/junjie.zhang/dsh/deepseek-harness`.

## Creating `muse`

Only after remote `main` equals the final Phase 2 release HEAD and the worktree is clean:

1. Re-check local existence: `git show-ref --verify refs/heads/muse`.
2. Re-check remote existence: `git ls-remote --heads origin muse`.
3. If either exists, STOP and report; do not delete, reset or overwrite it.
4. Confirm current HEAD equals the verified final release HEAD.
5. Create and switch with `git switch -c muse`.
6. Verify current branch is `muse` and its HEAD equals the release HEAD.
7. Do not push `muse` unless the user/planner explicitly authorizes it.

The original snapshot said only `main` existed and `muse` did not, but actual execution must always perform the checks above.
