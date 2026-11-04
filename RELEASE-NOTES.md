# Workbench distribution

This branch carries the prebuilt payload of `@icomposer/workbench` only
(no source history). Source of truth: the `main` branch of this repository.

| Field | Value |
| --- | --- |
| Version | 0.1.3 |
| Source commit | 5cb59e91b228d17905bb47ed0ae5d828982bcada |
| Source branch | main |
| Original release tag (pre-hotfix) | workbench-v0.1.3 |
| Tested with | dsh 0.2.1-rc.2, IMO 0.2.37, @insuremo/skills-tool 1.1.2 |

Install: `dsh plugin --profile <profile> add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"`

Note: this payload was verified on dsh 0.2.1-rc.2 only. It is not claimed
compatible with later dsh releases until a matching verification runs.

## 0.1.3 Windows containment hotfix

- Fixes five workspace-containment checks that rejected Windows backslash paths
  (code fix `2cd60d9c02cf41bcef8aa197d572e6fc7c2212db`).
- Validated with Win32 path-semantics tests and macOS fixture regressions;
  Windows end-to-end validation is still pending.
- Version remains 0.1.3. The original `workbench-v0.1.3` tag points to the
  pre-hotfix release and is not moved; there is no new tag. Install the exact
  hotfix from this distribution branch's new commit SHA.
