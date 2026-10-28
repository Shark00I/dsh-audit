# dsh-audit · Audit Console

**Current version: 1.0.0 (first release, 2026-10-28 — 1 update so far)**

An audit console for DeepSeek Harness plugins: check a plugin *before* installing it, then watch what it actually does.

- **Pre-install audit** — a local directory, `.tgz` / `.tar.gz`, npm spec, or https tarball. Text only: nothing is imported, executed, or unpacked to disk.
- **S–D grading** — every third-party plugin gets a grade and a 0–100 score backed by evidence: data destinations, command execution, credentials, autostart, outbound sends, install scripts.
- **Runtime monitor** — plugin start/stop, sensitive operations (file delete/write, process start, outbound network, credential access, plugin management), and token estimates for those tool calls.
- **Settings panel** — Settings → Audit: grades, runtime timeline, error log, pre-install check, monitor switches.
- **Never audits itself** — dsh-audit skips itself in both scanning and monitoring.

> Boundaries: the audit reads text only; it never imports or runs the inspected plugin. Installed-plugin scans make no network calls. The runtime monitor sends nothing; data stays in `$DSH_HOME/dsh-audit/`.

---

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | `>= 0.2.1-rc.0` (Desktop and `dsh web`) |
| Node | `>= 20` (the Node bundled with DSH is fine) |
| OS | Windows 10+ / macOS 12+ / Linux — pure ESM, no native code |
| Dependencies | none at runtime; `@deepseek-ai/*` comes from the host |

---

## Install

### Desktop

Use **Plugins → Add plugin** and pick the `dsh-audit` directory or archive, or:

```sh
dsh plugin --profile desktop add link:<absolute path to dsh-audit>
```

### `dsh web`

```sh
dsh plugin --profile web add dsh-audit         # once published to npm
dsh plugin --profile web add link:<absolute path>
```

Open **Settings → Audit**. No restart needed; if the entry does not appear, refresh the page once.

---

## Usage

### Settings panel

| Tab | Contents |
| --- | --- |
| Grades | grade badge, score meter and evidence chips per plugin; expand for destinations, install scripts, autostart, outbound sends, sample lines and advice |
| Runtime | running plugins, per-plugin tool token estimates, timeline of starts/stops/sensitive calls/manager changes |
| Errors | plugin load failures, tool errors, session errors |
| Pre-install | type a directory/archive/npm spec and get a verdict: install or not, and what to turn off |
| Settings | monitor switches, sensitive-call recording, startup scan, exclude list, npm registry, clear |

### Agent tools

```
plugin_audit                audit installed plugins (profile?, plugin?, detail?)
plugin_audit_preinstall     audit a not-yet-installed target (target: dir/archive/npm spec/https tarball)
```

`plugin_audit` returns a Markdown report: overview → per-plugin grade/score/evidence → verdict. `detail: false` drops the URL list.

### HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-audit/api/state` | version, settings, last scan, events, errors, running plugins |
| GET | `/dsh-audit/api/events?limit=&type=&plugin=` | events and errors |
| POST | `/dsh-audit/api/scan` | trigger a scan (same-origin) |
| POST | `/dsh-audit/api/preinstall` | `{ target }` pre-install audit (same-origin) |
| POST | `/dsh-audit/api/settings` | `{ patch }` update settings (same-origin) |
| POST | `/dsh-audit/api/clear` | clear events and errors (same-origin) |

---

## Grading

The score starts at 100 and drops by evidence; the grade is a band of the score. Scores rank risk only — they are **not** a security proof.

| Grade | Score | Meaning | Advice |
| --- | --- | --- | --- |
| **S** | 90–100 | low risk | safe to install |
| **A** | 75–89 | acceptable | install, then tighten per advice |
| **B** | 60–74 | keep an eye | read the evidence first |
| **C** | 40–59 | careful | check command execution and outbound hosts |
| **D** | 0–39 | high risk | do not install unless you trust the source |

Penalties: dynamic execution −25; system autostart −12; obfuscation −12; `child_process` −10; install scripts −10 (plus −10 when they download/execute); external POST −10; decode-then-execute −8; native modules −4; credential keywords −3; local server/timers −3; file writes −2; credentials + external host −4; more than 5 MB scanned −2.

Noise control: README/comments, locale message bundles, minified one-line bundles, and bundled installer scripts skip the lexical rules (URLs are still collected).

---

## Runtime monitor

Only three facts are recorded:

1. **Start/stop** — on `internal/status` entering/leaving ACTIVE, with duration.
2. **Sensitive calls** — `tools/pre-execute` + `tools/result`, only when a rule matches: delete/write/run/network/credential patterns in shell commands, file paths from `write`/`edit`, `plugin_manager` actions, and `web_fetch`/`web_search` targets.
3. **Token estimate** — arguments + result text at four characters per token, attributed to the plugin that registered the tool (attribution comes from a registry snapshot diff taken on plugin lifecycle changes).

Nothing polls, nothing watches files. Events sit in a 600-entry ring and flush to `$DSH_HOME/dsh-audit/events.jsonl` every 3 s or every 80 events, rotating at 5 MB. Idle cost is effectively zero.

A plugin does not itself spend model tokens; what is counted here is the tool calls its registration causes. A plugin with no registered tools shows 0.

---

## What the pre-install audit cannot see

Minified/obfuscated code, URLs assembled at runtime, dynamic `import()`, native `.node` behaviour, and anything inside dependencies (`node_modules` is not expanded). A low score is not proof of malice and a high score is not proof of safety.

---

## Extension API

The plugin provides `ctx.audit` (a Cordis service removed with the plugin):

```js
ctx.audit.registerRule({ id, label, weight, tag, re })  // static rule for future scans
ctx.audit.onEvent((event) => {})                        // runtime event subscription
ctx.audit.record({ type, plugin, detail })              // custom timeline event
ctx.audit.recordError({ message })                      // custom error entry
await ctx.audit.scan()                                  // rescan installed plugins
await ctx.audit.preinstall('pkg@1.0.0')                 // audit a target
```

Rules live in `lib/rules.js`, scoring in `scoreOf()` in `lib/scan.js`, runtime classification in `classifyCall()` in `lib/runtime.js`. Edit and restart DSH (HMR does not watch directories outside the profile).

---

## Data & privacy

Everything is written under `$DSH_HOME/dsh-audit/` (`settings.json`, `scan.json`, `events.jsonl`, `errors.jsonl`). No telemetry, no uploads. The only network access is a pre-install audit you explicitly start with an npm spec or https URL; it goes straight to `registry.npmjs.org` or the registry you configured.

---

## Layout

```
dsh-audit/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # mounts row id: dsh-audit
├── index.js              # Host half
├── client.js             # Client half (settings page)
├── lib/                  # rules, scan, preinstall, tar, runtime, store, report
├── locale/{en,zh}.json   # inventory title/description
├── icon.svg
├── CHANGELOG.md
└── LICENSE
```

---

## Publishing

```sh
npm publish --access public
```

Marketplace: the catalog is the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — open a PR there with one entry. This repository is a complete, directly installable GitHub source (`dsh plugin add link:<dir>`).

Pre-flight:

```sh
node --check index.js && node --check client.js && node --check lib/*.js
npm pack --dry-run
```

---

## License

MIT — see [LICENSE](LICENSE).
