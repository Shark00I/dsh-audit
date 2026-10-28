/**
 * dsh-audit · 审计台 — browser half.
 *
 * One settings page: the static audit report, the live runtime timeline, the
 * error log, a pre-install check box, and the monitor switches. Everything is
 * read from `/dsh-audit/api/*`; the page itself holds no state beyond the tab.
 */
window.__ModuleLoader__.load({
  id: 'dsh-audit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-audit'
    const API = '/dsh-audit/api'
    const POLL_MS = 6000

    const CSS = `
.dsh-au{max-width:920px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
.dsh-au-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dsh-au-title{margin:0;font-size:18px;font-weight:600;line-height:24px}
.dsh-au-sub{margin:4px 0 0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-au-actions{display:flex;gap:8px;align-items:center;flex:none}
.dsh-au-btn{font:inherit;font-size:12.5px;line-height:18px;padding:5px 12px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-au-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-au-btn[disabled]{opacity:.5;cursor:default}
.dsh-au-btn.dsh-au-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsh-au-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.dsh-au-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.dsh-au-num{font-size:20px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}
.dsh-au-cap{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-au-tabs{display:flex;gap:20px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-top:2px}
.dsh-au-tab{font:inherit;font-size:13px;line-height:20px;padding:7px 1px 9px;background:0 0;border:0;cursor:pointer;color:var(--dsw-alias-label-tertiary);position:relative}
.dsh-au-tab:hover,.dsh-au-tab[data-on="true"]{color:var(--dsw-alias-label-primary)}
.dsh-au-tab[data-on="true"]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.dsh-au-panel{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-au-row{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-au-rowhead{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
.dsh-au-rowhead:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-au-grade{flex:none;width:26px;height:26px;border-radius:7px;display:grid;place-items:center;font-size:13px;font-weight:700;color:#fff}
.dsh-au-name{font-size:13.5px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-au-ver{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-weight:400}
.dsh-au-grow{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-au-meter{width:96px;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none}
.dsh-au-meter>i{display:block;height:100%;border-radius:2px}
.dsh-au-score{font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);width:38px;text-align:right;flex:none}
.dsh-au-chips{display:flex;flex-wrap:wrap;gap:4px}
.dsh-au-chip{font-size:11px;line-height:16px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1)}
.dsh-au-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsh-au-chip.bad{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-au-body{border-top:.5px solid var(--dsw-alias-border-l1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base)}
.dsh-au-kv{display:grid;grid-template-columns:78px 1fr;gap:4px 10px;font-size:12.5px;line-height:18px}
.dsh-au-k{color:var(--dsw-alias-label-tertiary)}
.dsh-au-v{min-width:0;word-break:break-word}
.dsh-au-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto}
.dsh-au-note{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin:0}
.dsh-au-empty{border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:22px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.dsh-au-tl{display:flex;flex-direction:column;gap:1px}
.dsh-au-ev{display:grid;grid-template-columns:62px 96px 1fr auto;gap:8px;align-items:center;padding:5px 8px;border-radius:6px;font-size:12px;line-height:17px}
.dsh-au-ev:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-au-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-au-plug{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-au-det{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-au-tok{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-au-dot{display:inline-block;width:6px;height:6px;border-radius:3px;margin-right:5px;vertical-align:1px}
.dsh-au-form{display:flex;flex-direction:column;gap:10px;max-width:620px}
.dsh-au-field{display:flex;flex-direction:column;gap:4px}
.dsh-au-label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dsh-au-input{font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsh-au-switch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px}
.dsh-au-switch:last-child{border-bottom:0}
.dsh-au-sw{width:34px;height:20px;border-radius:10px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-2);position:relative;flex:none;transition:background .15s}
.dsh-au-sw[data-on="true"]{background:var(--dsw-alias-brand-primary)}
.dsh-au-sw>i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#fff;transition:transform .15s}
.dsh-au-sw[data-on="true"]>i{transform:translateX(14px)}
.dsh-au-err{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:7px;border:.5px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);font-size:12.5px;line-height:17px}
.dsh-au-errhead{display:flex;gap:8px;align-items:baseline;color:var(--dsw-alias-state-error-primary);font-weight:600;font-size:12px}
.dsh-au-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);max-height:280px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
`

    const TONE = {
      safe: 'var(--dsw-alias-state-success-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      notice: 'var(--dsw-alias-state-warn-primary)',
      watch: 'var(--dsw-alias-state-warn-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }
    const EVENT_TONE = {
      'plugin.start': 'var(--dsw-alias-state-success-primary)',
      'plugin.stop': 'var(--dsw-alias-state-idle-primary)',
      sensitive: 'var(--dsw-alias-state-warn-primary)',
      manager: 'var(--dsw-alias-brand-primary)',
      scan: 'var(--dsw-alias-brand-primary)',
      preinstall: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const zh = {
      nav: '审计',
      title: '审计台',
      subtitle: '安装前静态检查、插件分级评分、运行时操作与报错，一处看完。',
      loading: '读取中…',
      refresh: '刷新',
      scan: '重新扫描',
      scanning: '扫描中…',
      rescanHint: '只读扫描本机已安装的第三方插件，不执行它们的代码。',
      plugins: '插件评分',
      runtime: '运行时',
      errors: '错误',
      preinstall: '安装前检查',
      settings: '设置',
      counts: ['插件', '需留意', '高风险', '监控中'],
      grade: '等级',
      score: '评分',
      evidence: '证据',
      dataGoes: '数据去向',
      hosts: '域名',
      hostsNone: '代码里未发现外部域名',
      undeclared: 'README 未声明',
      installScripts: '安装期脚本',
      noInstallScripts: '无 preinstall/install/postinstall',
      autostart: '自启动/常驻',
      noAutostart: '未发现系统级自启动',
      autostartYes: '命中系统自启动关键词',
      outgoing: '自行外发',
      outgoingNone: '未发现',
      outgoingPost: '检出向外部地址 POST 的路径',
      outgoingSome: '有出站请求，未检出明显 POST',
      advice: '建议',
      path: '路径',
      profiles: 'profile',
      entry: '入口',
      size: '扫描体积',
      none: '暂无数据。点右上角「重新扫描」。',
      emptyRuntime: '还没有运行时事件。插件启动、敏感操作、安装变化会出现在这里。',
      emptyErrors: '没有记录到错误。',
      running: '正在运行',
      tokens: 'tokens',
      noRunning: '当前没有观测到运行中的插件。',
      preinstallTitle: '审计一个还没安装的插件',
      preinstallHint: '输入本地目录、.tgz 路径、npm 包名（如 dsh-audit@1.0.0）或 https 压缩包地址。只读文本，不执行、不解压到磁盘。',
      preinstallPlaceholder: '例如：C:\\path\\to\\plugin 或 dshmarket@1.70.1',
      preinstallRun: '开始检查',
      preinstallRunning: '检查中…',
      preinstallEmpty: '结果会显示在这里：能不能装、装后关什么。',
      settingsMonitor: '运行时监控',
      settingsMonitorHint: '记录插件启停、敏感操作与工具 token 估算。',
      settingsSensitive: '记录敏感操作',
      settingsSensitiveHint: '删除/写入文件、运行程序、外发网络、读写凭据、插件管理。',
      settingsAutoScan: '启动后自动扫描',
      settingsAutoScanHint: '在后台读一次已安装插件，不阻塞启动。',
      settingsExclude: '不监控的插件',
      settingsExcludeHint: '逗号分隔的包名，例如 dshmarket, dsh-context。',
      settingsRegistry: '安装前检查的 npm 源',
      clear: '清空事件与错误',
      cleared: '已清空',
      saved: '已保存',
      save: '保存',
      scannedAt: '扫描于',
      selfSkipped: '已跳过 dsh-audit 自身：本插件不审计自己。',
      footer: '评分只用于排序，不是安全证明；以证据为准。',
      notReady: '存储尚未就绪。',
      request: '请求',
      noEvidence: '未命中命令执行、凭据、动态执行等规则。',
    }

    const en = {
      nav: 'Audit',
      title: 'Audit Console',
      subtitle: 'Pre-install checks, plugin grades, runtime actions and errors in one place.',
      loading: 'Loading…',
      refresh: 'Refresh',
      scan: 'Rescan',
      scanning: 'Scanning…',
      rescanHint: 'Read-only scan of installed third-party plugins; their code is never run.',
      plugins: 'Grades',
      runtime: 'Runtime',
      errors: 'Errors',
      preinstall: 'Pre-install',
      settings: 'Settings',
      counts: ['Plugins', 'Watch', 'High risk', 'Monitored'],
      grade: 'Grade',
      score: 'Score',
      evidence: 'Evidence',
      dataGoes: 'Data goes to',
      hosts: 'hosts',
      hostsNone: 'No external host found in code',
      undeclared: 'Undeclared in README',
      installScripts: 'Install scripts',
      noInstallScripts: 'No preinstall/install/postinstall',
      autostart: 'Autostart',
      noAutostart: 'No system autostart found',
      autostartYes: 'System autostart keywords found',
      outgoing: 'Self-sends',
      outgoingNone: 'Not found',
      outgoingPost: 'External POST path detected',
      outgoingSome: 'Outbound requests, no obvious POST',
      advice: 'Advice',
      path: 'Path',
      profiles: 'profiles',
      entry: 'Entry',
      size: 'Scanned',
      none: 'Nothing yet. Press Rescan.',
      emptyRuntime: 'No runtime events yet. Plugin starts, sensitive calls and install changes appear here.',
      emptyErrors: 'No recorded errors.',
      running: 'Running',
      tokens: 'tokens',
      noRunning: 'No running plugins observed.',
      preinstallTitle: 'Audit a plugin before installing it',
      preinstallHint: 'A local directory, a .tgz path, an npm spec (dsh-audit@1.0.0) or an https tarball. Text only: nothing runs, nothing is unpacked to disk.',
      preinstallPlaceholder: 'e.g. C:\\path\\to\\plugin or dshmarket@1.70.1',
      preinstallRun: 'Check',
      preinstallRunning: 'Checking…',
      preinstallEmpty: 'The verdict appears here: install or not, and what to turn off.',
      settingsMonitor: 'Runtime monitor',
      settingsMonitorHint: 'Record plugin start/stop, sensitive calls and estimated tool tokens.',
      settingsSensitive: 'Record sensitive calls',
      settingsSensitiveHint: 'File delete/write, process start, outbound network, credential access, plugin management.',
      settingsAutoScan: 'Scan on startup',
      settingsAutoScanHint: 'One background read of installed plugins; never blocks startup.',
      settingsExclude: 'Excluded plugins',
      settingsExcludeHint: 'Comma-separated package names, e.g. dshmarket, dsh-context.',
      settingsRegistry: 'npm registry for pre-install checks',
      clear: 'Clear events and errors',
      cleared: 'Cleared',
      saved: 'Saved',
      save: 'Save',
      scannedAt: 'Scanned',
      selfSkipped: 'dsh-audit skips itself: this plugin does not audit itself.',
      footer: 'Scores rank risk only; they are not a security proof. Evidence decides.',
      notReady: 'Store is not ready yet.',
      request: 'request',
      noEvidence: 'No command execution, credential or dynamic-execution rule matched.',
    }

    async function getJson(path, init) {
      const response = await fetch(API + path, init)
      const text = await response.text()
      let data = null
      try {
        data = text === '' ? null : JSON.parse(text)
      } catch {
        data = { error: text }
      }
      if (!response.ok) throw new Error(data?.error ?? 'HTTP ' + response.status)
      return data
    }

    function fmtTime(value) {
      if (!value) return ''
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function fmtDate(value) {
      if (!value) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function fmtBytes(value) {
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }

    function duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const s = Math.round(ms / 1000)
      if (s < 60) return s + 's'
      const m = Math.round(s / 60)
      if (m < 60) return m + 'm'
      return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
    }

    function Badge({ grade, tone }) {
      return h('span', {
        className: 'dsh-au-grade',
        style: { background: TONE[tone] ?? 'var(--dsw-alias-label-tertiary)' },
        title: grade,
      }, grade)
    }

    function Meter({ score, tone }) {
      const color = TONE[tone] ?? 'var(--dsw-alias-brand-primary)'
      return h('div', { className: 'dsh-au-meter' },
        h('i', { style: { width: Math.max(2, Math.min(100, score)) + '%', background: color } }))
    }

    function Chips({ item, t }) {
      const chips = []
      for (const hit of item.hits ?? []) {
        const bad = hit.id === 'exec' || hit.id === 'eval' || hit.id === 'persist'
        const warn = hit.id === 'credentials' || hit.id === 'decode' || hit.id === 'native'
        chips.push(h('span', { key: hit.id, className: 'dsh-au-chip' + (bad ? ' bad' : warn ? ' warn' : '') }, hit.label))
      }
      if (item.postExternal) chips.push(h('span', { key: 'post', className: 'dsh-au-chip bad' }, t('outgoingPost')))
      if (item.installScripts?.length > 0) chips.push(h('span', { key: 'install', className: 'dsh-au-chip warn' }, t('installScripts')))
      if ((item.hosts?.length ?? 0) > 0) chips.push(h('span', { key: 'hosts', className: 'dsh-au-chip' }, (item.hosts.length) + ' ' + t('hosts')))
      return h('div', { className: 'dsh-au-chips' }, chips)
    }

    function PluginRow({ item, t }) {
      const [open, setOpen] = useState(false)
      const hosts = item.hosts ?? []
      const endpoints = hosts.filter((host) => host.endpoints > 0)
      const evidence = item.hits ?? []
      return h('div', { className: 'dsh-au-row' },
        h('div', { className: 'dsh-au-rowhead', onClick: () => setOpen(!open), role: 'button', tabIndex: 0,
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } } },
          h(Badge, { grade: item.grade, tone: item.tone }),
          h('div', { className: 'dsh-au-grow' },
            h('div', { className: 'dsh-au-name' }, item.name, h('span', { className: 'dsh-au-ver' }, item.version ?? '')),
            h(Chips, { item, t })),
          h(Meter, { score: item.score, tone: item.tone }),
          h('span', { className: 'dsh-au-score' }, String(item.score))),
        open ? h('div', { className: 'dsh-au-body' },
          h('div', { className: 'dsh-au-kv' },
            h('span', { className: 'dsh-au-k' }, t('dataGoes')),
            h('span', { className: 'dsh-au-v' }, hosts.length === 0 ? t('hostsNone')
              : hosts.slice(0, 8).map((host) => h('div', { key: host.host },
                h('span', { className: 'dsh-au-dot', style: { background: host.endpoints > 0 ? TONE.danger : 'var(--dsw-alias-label-tertiary)' } }),
                host.host, ' ×' + host.count, host.endpoints > 0 ? ' · ' + t('request') : '', host.declared ? '' : ' ⚠'))),
            h('span', { className: 'dsh-au-k' }, t('installScripts')),
            h('span', { className: 'dsh-au-v' }, item.installScripts?.length > 0
              ? item.installScripts.join(' / ') + (item.installActive ? '（含下载/执行命令）' : '')
              : t('noInstallScripts')),
            h('span', { className: 'dsh-au-k' }, t('autostart')),
            h('span', { className: 'dsh-au-v' }, evidence.some((hit) => hit.id === 'persist') ? t('autostartYes') : t('noAutostart')),
            h('span', { className: 'dsh-au-k' }, t('outgoing')),
            h('span', { className: 'dsh-au-v' }, item.postExternal ? t('outgoingPost') : hosts.length > 0 ? t('outgoingSome') : t('outgoingNone')),
            h('span', { className: 'dsh-au-k' }, t('entry')),
            h('span', { className: 'dsh-au-v dsh-au-mono' }, (item.entry ?? '') + '  ·  ' + fmtBytes(item.bytes) + '  ·  ' + String(item.files ?? 0) + ' files'),
            h('span', { className: 'dsh-au-k' }, t('path')),
            h('span', { className: 'dsh-au-v dsh-au-mono' }, item.dir)),
          evidence.length > 0 ? h('div', null,
            h('p', { className: 'dsh-au-note' }, t('evidence')),
            ...evidence.map((hit) => h('div', { key: hit.id, style: { marginBottom: '6px' } },
              h('div', { style: { fontSize: '12.5px', marginBottom: '2px' } }, hit.label + ' ×' + hit.count),
              ...(hit.samples ?? []).map((sample, index) => h('pre', { key: index, className: 'dsh-au-mono' }, sample)))))
            : h('p', { className: 'dsh-au-note' }, t('noEvidence')),
          h('div', null,
            h('p', { className: 'dsh-au-note' }, t('advice')),
            ...(item.advice ?? []).map((line, index) => h('div', { key: index, style: { fontSize: '12.5px', lineHeight: '18px' } }, '· ' + line))))
          : null)
    }

    function PluginsPanel({ state, t }) {
      const items = state?.scan?.items ?? []
      if (items.length === 0) return h('div', { className: 'dsh-au-empty' }, t('none'))
      return h('div', { className: 'dsh-au-panel' },
        state?.scan?.selfSkipped ? h('p', { className: 'dsh-au-note' }, t('selfSkipped')) : null,
        ...items.map((item) => h(PluginRow, { key: item.name, item, t })))
    }

    function RuntimePanel({ state, t }) {
      const events = [...(state?.events ?? [])].reverse()
      const running = state?.running ?? []
      const totals = state?.monitor?.totals ?? []
      return h('div', { className: 'dsh-au-panel' },
        h('div', { className: 'dsh-au-card' },
          h('div', { className: 'dsh-au-cap' }, t('running')),
          running.length === 0 ? h('div', { className: 'dsh-au-note' }, t('noRunning'))
            : running.map((row) => h('div', { key: row.plugin + row.entry, style: { fontSize: '12.5px', lineHeight: '19px' } },
              h('span', { className: 'dsh-au-dot', style: { background: TONE.safe } }), row.plugin, ' ', h('span', { className: 'dsh-au-cap' }, duration(Date.now() - row.startedAt)))),
          totals.length > 0 ? h('div', { style: { marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '10px' } },
            ...totals.map((row) => h('span', { key: row.plugin || '(未知来源)', className: 'dsh-au-chip' },
              (row.plugin || '(未知来源)') + ' · ' + String(row.calls) + ' calls · ' + String(row.tokens) + ' ' + t('tokens')))) : null),
        events.length === 0 ? h('div', { className: 'dsh-au-empty' }, t('emptyRuntime'))
          : h('div', { className: 'dsh-au-tl' },
            ...events.map((event, index) => h('div', { key: index, className: 'dsh-au-ev' },
              h('span', { className: 'dsh-au-time' }, fmtTime(event.at)),
              h('span', { className: 'dsh-au-plug' },
                h('span', { className: 'dsh-au-dot', style: { background: EVENT_TONE[event.type] ?? 'var(--dsw-alias-label-tertiary)' } }),
                event.plugin ?? event.type),
              h('span', { className: 'dsh-au-det' }, describe(event)),
              h('span', { className: 'dsh-au-tok' }, event.tokens ? String(event.tokens) + ' tok' : '')))))
    }

    function describe(event) {
      if (event.type === 'plugin.start') return '启动'
      if (event.type === 'plugin.stop') return '停止，运行 ' + duration(event.ms)
      if (event.type === 'sensitive') return (event.label ?? event.kind) + ' · ' + String(event.tool ?? '') + ' · ' + String(event.detail ?? '').slice(0, 120)
      if (event.type === 'scan') return '扫描完成，' + String(event.plugins) + ' 个插件'
      if (event.type === 'preinstall') return '安装前检查 · ' + String(event.plugin) + ' · ' + String(event.grade)
      if (event.type === 'manager') return '插件管理变化'
      return event.type
    }

    function ErrorsPanel({ state, t }) {
      const errors = [...(state?.errors ?? [])].reverse()
      if (errors.length === 0) return h('div', { className: 'dsh-au-empty' }, t('emptyErrors'))
      return h('div', { className: 'dsh-au-panel' },
        ...errors.map((error, index) => h('div', { key: index, className: 'dsh-au-err' },
          h('div', { className: 'dsh-au-errhead' },
            h('span', null, error.source ?? 'error'),
            h('span', null, error.plugin ?? ''),
            h('span', { style: { marginLeft: 'auto', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } }, fmtDate(error.at))),
          h('div', null, error.message ?? ''))))
    }

    function PreinstallPanel({ t }) {
      const [target, setTarget] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')
      const run = async () => {
        if (target.trim() === '' || busy) return
        setBusy(true)
        setError('')
        try {
          const data = await getJson('/preinstall', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: target.trim() }),
          })
          setResult(data)
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { className: 'dsh-au-panel' },
        h('div', { className: 'dsh-au-card' },
          h('div', { className: 'dsh-au-name' }, t('preinstallTitle')),
          h('p', { className: 'dsh-au-note' }, t('preinstallHint')),
          h('div', { className: 'dsh-au-form' },
            h('div', { className: 'dsh-au-field' },
              h('input', {
                className: 'dsh-au-input',
                value: target,
                placeholder: t('preinstallPlaceholder'),
                onChange: (event) => setTarget(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') run() },
              })),
            h('div', null,
              h('button', { className: 'dsh-au-btn dsh-au-primary', disabled: busy, onClick: run }, busy ? t('preinstallRunning') : t('preinstallRun'))))),
        error !== '' ? h('div', { className: 'dsh-au-err' }, error) : null,
        result === null ? h('div', { className: 'dsh-au-empty' }, t('preinstallEmpty'))
          : h('div', { className: 'dsh-au-panel' },
            h('div', { className: 'dsh-au-row' },
              h('div', { className: 'dsh-au-rowhead' },
                h(Badge, { grade: result.item.grade, tone: result.item.tone }),
                h('div', { className: 'dsh-au-grow' },
                  h('div', { className: 'dsh-au-name' }, result.item.name || '(未命名)', h('span', { className: 'dsh-au-ver' }, result.item.version ?? '')),
                  h(Chips, { item: result.item, t })),
                h(Meter, { score: result.item.score, tone: result.item.tone }),
                h('span', { className: 'dsh-au-score' }, String(result.item.score)))),
            h('pre', { className: 'dsh-au-pre' }, String(result.markdown ?? ''))))
    }

    function SettingsPanel({ state, t, onSaved }) {
      const [draft, setDraft] = useState(null)
      const [note, setNote] = useState('')
      const settingsKey = JSON.stringify(state?.settings ?? {})
      useEffect(() => {
        setDraft({ ...(state?.settings ?? {}) })
        // Re-sync only when the persisted settings actually changed; the panel
        // polls every few seconds and must not overwrite in-progress edits.
      }, [settingsKey])
      if (draft === null) return h('div', { className: 'dsh-au-empty' }, t('loading'))
      const toggle = (key) => setDraft({ ...draft, [key]: draft[key] !== true })
      const save = async () => {
        try {
          await getJson('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: {
              monitoring: draft.monitoring === true,
              recordSensitive: draft.recordSensitive === true,
              autoScanOnStart: draft.autoScanOnStart === true,
              exclude: String(draft.excludeText ?? (draft.exclude ?? []).join(', ')).split(',').map((item) => item.trim()).filter(Boolean),
              preinstallRegistry: String(draft.preinstallRegistry ?? ''),
            } }),
          })
          setNote(t('saved'))
          onSaved?.()
        } catch (reason) {
          setNote(String(reason?.message ?? reason))
        }
      }
      const clear = async () => {
        try {
          await getJson('/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          setNote(t('cleared'))
        } catch (reason) {
          setNote(String(reason?.message ?? reason))
        }
      }
      const row = (key, title, hint) => h('div', { className: 'dsh-au-switch' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', null, title),
          h('span', { className: 'dsh-au-cap' }, hint)),
        h('button', {
          className: 'dsh-au-sw',
          'data-on': draft[key] === true ? 'true' : 'false',
          role: 'switch',
          'aria-checked': draft[key] === true,
          onClick: () => toggle(key),
        }, h('i')))
      return h('div', { className: 'dsh-au-panel' },
        h('div', { className: 'dsh-au-card', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          row('monitoring', t('settingsMonitor'), t('settingsMonitorHint')),
          row('recordSensitive', t('settingsSensitive'), t('settingsSensitiveHint')),
          row('autoScanOnStart', t('settingsAutoScan'), t('settingsAutoScanHint'))),
        h('div', { className: 'dsh-au-card', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { className: 'dsh-au-field' },
            h('span', { className: 'dsh-au-label' }, t('settingsExclude')),
            h('span', { className: 'dsh-au-cap' }, t('settingsExcludeHint')),
            h('input', {
              className: 'dsh-au-input',
              value: draft.excludeText ?? (draft.exclude ?? []).join(', '),
              onChange: (event) => setDraft({ ...draft, excludeText: event.target.value }),
            })),
          h('div', { className: 'dsh-au-field' },
            h('span', { className: 'dsh-au-label' }, t('settingsRegistry')),
            h('input', {
              className: 'dsh-au-input',
              value: draft.preinstallRegistry ?? '',
              onChange: (event) => setDraft({ ...draft, preinstallRegistry: event.target.value }),
            }))),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', { className: 'dsh-au-btn dsh-au-primary', onClick: save }, t('save')),
          h('button', { className: 'dsh-au-btn', onClick: clear }, t('clear')),
          note !== '' ? h('span', { className: 'dsh-au-cap' }, note) : null))
    }

    function AuditSection(props) {
      const t = props?.t ?? ((key) => {
        const value = zh[key]
        return Array.isArray(value) ? value.join(' ') : (value ?? key)
      })
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('plugins')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const data = await getJson('/state')
          if (alive.current) {
            setState(data)
            setError('')
          }
        } catch (reason) {
          if (alive.current) setError(String(reason?.message ?? reason))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const scan = async () => {
        setBusy(true)
        try {
          await getJson('/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          await load()
        } catch (reason) {
          setError(String(reason?.message ?? reason))
        } finally {
          setBusy(false)
        }
      }

      const counts = state?.counts ?? { S: 0, A: 0, B: 0, C: 0, D: 0 }
      const total = (counts.S ?? 0) + (counts.A ?? 0) + (counts.B ?? 0) + (counts.C ?? 0) + (counts.D ?? 0)
      const running = state?.running?.length ?? 0
      const scannedAt = state?.scan?.at
      const tabRows = [
        ['plugins', t('plugins')],
        ['runtime', t('runtime')],
        ['errors', t('errors'), state?.errors?.length ?? 0],
        ['preinstall', t('preinstall')],
        ['settings', t('settings')],
      ]

      return h('div', { className: 'dsh-au' },
        h('div', { className: 'dsh-au-head' },
          h('div', null,
            h('h2', { className: 'dsh-au-title' }, t('title')),
            h('p', { className: 'dsh-au-sub' }, t('subtitle'))),
          h('div', { className: 'dsh-au-actions' },
            h('button', { className: 'dsh-au-btn', onClick: load }, t('refresh')),
            h('button', { className: 'dsh-au-btn dsh-au-primary', disabled: busy, onClick: scan }, busy ? t('scanning') : t('scan')))),
        h('div', { className: 'dsh-au-cards' },
          h('div', { className: 'dsh-au-card' }, h('div', { className: 'dsh-au-num' }, String(total)), h('div', { className: 'dsh-au-cap' }, t('counts')[0])),
          h('div', { className: 'dsh-au-card' }, h('div', { className: 'dsh-au-num', style: { color: TONE.notice } }, String((counts.B ?? 0) + (counts.C ?? 0))), h('div', { className: 'dsh-au-cap' }, t('counts')[1])),
          h('div', { className: 'dsh-au-card' }, h('div', { className: 'dsh-au-num', style: { color: TONE.danger } }, String(counts.D ?? 0)), h('div', { className: 'dsh-au-cap' }, t('counts')[2])),
          h('div', { className: 'dsh-au-card' }, h('div', { className: 'dsh-au-num' }, String(running)), h('div', { className: 'dsh-au-cap' }, t('counts')[3]))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { className: 'dsh-au-cap' }, scannedAt ? t('scannedAt') + ' ' + fmtDate(scannedAt) : t('rescanHint')),
          h('span', { className: 'dsh-au-cap' }, t('footer'))),
        h('div', { className: 'dsh-au-tabs', role: 'tablist' },
          ...tabRows.map(([id, label, badge]) => h('button', {
            key: id,
            className: 'dsh-au-tab',
            'data-on': tab === id ? 'true' : 'false',
            role: 'tab',
            onClick: () => setTab(id),
          }, label, badge ? ' ' + String(badge) : ''))),
        error !== '' ? h('div', { className: 'dsh-au-err' }, error) : null,
        tab === 'plugins' ? h(PluginsPanel, { state, t }) : null,
        tab === 'runtime' ? h(RuntimePanel, { state, t }) : null,
        tab === 'errors' ? h(ErrorsPanel, { state, t }) : null,
        tab === 'preinstall' ? h(PreinstallPanel, { t }) : null,
        tab === 'settings' ? h(SettingsPanel, { state, t, onSaved: load }) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-audit: dictionaries')
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const id = 'dsh-audit/styles'
          let tag = document.querySelector('style[data-plugin-css="' + id + '"]')
          if (tag === null) {
            tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-audit'
            tag.dataset.pluginCss = id
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {
            tag?.remove()
          }
        }, 'dsh-audit: styles')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: 'audit',
            order: 60,
            label: () => t('nav'),
            locale: NS,
          }, AuditSection))
      },
    }
  },
})
