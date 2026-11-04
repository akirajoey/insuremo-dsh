# Workbench distribution

This branch carries the prebuilt payload of `@icomposer/workbench` only
(no source history). Source of truth: the `main` branch of this repository.

| Field | Value |
| --- | --- |
| Version | 0.1.3 |
| Source commit | 531bed7f06a16e3c29cade308ac7748785c5efbd |
| Source branch | main (built from fix/plugin-compliance) |
| Tag | workbench-v0.1.3 |
| Tested with | dsh 0.2.1-rc.2, IMO 0.2.37, @insuremo/skills-tool 1.1.2 |

Install: `dsh plugin --profile <profile> add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"`

Note: this payload was verified on dsh 0.2.1-rc.2 only. It is not claimed
compatible with later dsh releases until a matching verification runs.
