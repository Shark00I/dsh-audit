# Changelog

All notable changes to `dsh-audit`. Version numbering follows [SemVer](https://semver.org/).

## 1.0.0 — 2026-10-28

First public release. Replaces the earlier single-file `dsh-shengji` scanner.

### Added

- **Pre-install audit** (`plugin_audit_preinstall`): local directory, `.tgz` / `.tar.gz`, npm package spec, or https tarball. Archives are parsed in memory by a small built-in tar reader — nothing is unpacked to disk, nothing is executed. Verdict includes "what to turn off after installing".
- **S–D grading** with 0–100 score and evidence table: data destinations, command execution, credential access, dynamic execution, install scripts, autostart, outbound POST, native modules, size.
- **Runtime monitor**: plugin start/stop with duration (`internal/status`), sensitive tool calls (`tools/pre-execute` + `tools/result`), tool-to-plugin attribution from registry snapshot diffs, per-plugin token estimates (4 chars/token).
- **Bounded local store**: 600-entry in-memory ring, batched JSONL flush (3 s / 80 events), 5 MB rotation, no polling, no file watching.
- **Settings panel** (`settings.section`): Grades, Runtime, Errors, Pre-install, Settings tabs; theme-token styling; EN/ZH locale.
- **HTTP API** under `/dsh-audit/api/*` for the panel and third-party scripts.
- **Extension seam** via `ctx.audit`: `registerRule`, `onEvent`, `record`, `recordError`, `scan`, `preinstall`.
- **Noise controls**: locale/message bundles, comments and minified lines skip lexical rules; bundled installer scripts skip autostart rules; official `@deepseek-ai/*` packages are out of scope (both grading and monitoring).
- **Self-exclusion**: dsh-audit never audits or monitors itself.
- Bilingual README, CHANGELOG, MIT license, SVG icon, locale resources.

### Changed

- Replaced `dsh-shengji` (0.1.0, Host-only, one file): its scan logic was carried over, rebalanced (per-rule weights, grade bands, noise filters) and split into `lib/`.
- Tool definitions are built locally instead of importing `@deepseek-ai/dsh-tools`, so the bundle loads in profiles installed with `autoInstallPeers: false` (the Desktop default). No runtime npm dependency.
- `plugin_audit` keeps its name and parameters for compatibility; output now starts with a grade and includes per-plugin advice.

### Fixed

- Stop events were lost when a disposing fiber had already forgotten its loader entry — the monitor now matches fibers by object identity.
- Plugins that were already running when dsh-audit loaded are seeded into the running list instead of appearing only after their next restart.
- Score saturation: common patterns (file reads, network, credential-shaped strings in locale files) no longer push every plugin to D.
