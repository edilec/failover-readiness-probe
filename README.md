# Failover Readiness Probe

Read-only evaluation of a **local exported** recovery-dependency graph. The name “probe” does not mean a live health check: this tool does not connect to infrastructure, switch traffic, restart services, or execute a failover. A complete export and an explicit as-of time are required; the exporter owns the accuracy of observations.

## Run

Node.js 22+, zero dependencies. From this repository:

```sh
node bin/failover-readiness-probe.mjs --root examples --input passing.json
node bin/failover-readiness-probe.mjs --root examples --input failing.json
npm run check
```

`--root` confines reads by real path; `--input` is a relative path inside it. Optional `--human` writes one summary to stderr. Stdout is JSON report only. No output file is written. Configuration/option error: empty stdout, exit 2. Unreadable, malformed, non-UTF-8, incomplete or stale evidence: incomplete report, exit 2. Evaluated failed prerequisite: fail, exit 1. Every required prerequisite fresh and passing: pass, exit 0.

## Export format and decisions

Top level: `schemaVersion:"1"`, `complete:true`, `asOf` (UTC timestamp), `maxAgeHours` (nonnegative safe integer), `prerequisites`, `paths`. A prerequisite has an opaque `id`, `state` (`pass`, `fail`, `unknown`), `observedAt` UTC timestamp and `dependsOn` ID array; optional `note` is ignored, never emitted. A recovery path has `id` and nonempty `requires` ID array. Dependencies are evaluated transitively, with cycles and missing IDs incomplete. Observations dated after `asOf` are unknown. Evidence is fresh when `asOf - observedAt <= maxAgeHours`, including the exact boundary. At least one path and one prerequisite are required.

| Rule | Outcome |
| --- | --- |
| `path-blocked` | fail 1; at least one required prerequisite evaluated `fail` |
| `evidence-stale`, `evidence-future`, `evidence-unknown` | incomplete 2; readiness cannot be concluded |
| `dependency-unknown`, `dependency-cycle`, malformed/duplicate export, no paths | incomplete 2 |
| byte/record/depth/time limits, unreadable or duplicate-key JSON | incomplete 2 |

An unknown anywhere needed for a path takes precedence over a simultaneous failure: the whole report is incomplete, never a clean pass. Findings sort by `(location.file, location.pointer, ruleId)` using UTF-16 code-unit order. `@export` is a fixed logical role for the file named by `--input`; pointers give source ordinals. IDs, notes, host paths, credentials and raw evidence are not emitted. A pass does not certify that a real failover would succeed.

## Limits

1,048,576 UTF-8 bytes; 100 prerequisites; 20 recovery paths; 500 raw dependency references in total; JSON depth 4 from root depth 0; 5,000 ms measured by an injectable library clock. Exact N is accepted, N+1 incomplete. Strict UTF-8 decoding and duplicate-key rejection (including escaped keys) prevent ambiguous evidence. CLI read has a 5-second abort. No network, provider call, live probe, traffic switch, restart or auto-fix.
