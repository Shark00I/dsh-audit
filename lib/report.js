/**
 * Report rendering.
 *
 * The Markdown form is what the agent tool returns; the compact form is what
 * the settings panel and the scan cache store. Both derive from one analysis so
 * the UI and the text report can never disagree about a score.
 */

/** Strip the heavy internals (full URL list, samples beyond 2) for transport. */
export function compactPlugin(item) {
  return {
    name: item.name,
    version: item.version,
    description: item.description,
    official: item.official,
    enabled: item.enabled,
    profiles: item.profiles,
    rowIds: item.rowIds,
    readme: item.readme,
    entry: item.entry,
    files: item.files,
    bytes: item.bytes,
    score: item.score,
    grade: item.grade,
    gradeLabel: item.gradeLabel,
    tone: item.tone,
    repo: item.repo,
    license: item.license,
    installScripts: item.installScripts,
    installActive: item.installActive,
    prepare: item.prepare,
    postExternal: item.postExternal,
    native: item.native,
    truncated: item.truncated,
    advice: item.advice,
    undeclaredHosts: item.undeclaredHosts,
    hosts: item.hosts.map((host) => ({
      host: host.host,
      count: host.count,
      endpoints: host.endpoints,
      docs: host.docs,
      declared: host.declared,
      sample: host.sample,
    })),
    hits: item.hits.map((hit) => ({
      id: hit.id,
      label: hit.label,
      tag: hit.tag,
      count: hit.count,
      samples: hit.samples.slice(0, 2),
    })),
    dir: item.dir,
    scannedAt: item.scannedAt,
  }
}

function hostLine(host) {
  const flags = []
  if (host.endpoints > 0) flags.push('请求')
  if (host.docs > 0) flags.push('文档')
  if (host.declared) flags.push('README 已声明')
  return '  - ' + host.host + ' ×' + host.count + (flags.length > 0 ? '  [' + flags.join('/') + ']' : '')
}

function clipped(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * Render one plugin as Markdown.
 * @param {ReturnType<typeof compactPlugin>} item
 * @param {number} index 1-based position
 * @param {boolean} detail include the URL list
 */
export function renderPluginMarkdown(item, index, detail) {
  const endpoints = item.hosts.filter((host) => host.endpoints > 0)
  const lines = []
  lines.push('')
  lines.push('### ' + String(index) + ') ' + item.name + (item.version !== '' ? ' ' + item.version : ''))
  lines.push(
    '    等级 ' + item.grade + '（' + item.gradeLabel + '） · 评分 ' + String(item.score) + '/100 · ' +
      (item.official ? '官方包' : '第三方') +
      (item.dir !== '' ? ' · ' + (item.enabled ? '已启用' : '已停用') : ''),
  )
  if (item.description !== '') lines.push('    说明: ' + clipped(item.description, 160))
  if (item.dir !== '') lines.push('    路径: ' + item.dir)
  if (item.profiles.length > 0) lines.push('    profile: ' + item.profiles.join(', '))

  // 数据去向
  if (item.hosts.length === 0) {
    lines.push('    数据去向: 代码里未发现外部域名')
  } else {
    lines.push('    数据去向: ' + String(item.hosts.length) + ' 个域名，其中 ' + String(endpoints.length) + ' 个出现在请求上下文')
    for (const host of item.hosts.slice(0, 10)) lines.push(hostLine(host))
    if (item.hosts.length > 10) lines.push('    … 其余 ' + String(item.hosts.length - 10) + ' 个见完整清单')
    if (item.undeclaredHosts.length > 0) lines.push('    未在 README 声明: ' + item.undeclaredHosts.slice(0, 8).join(', '))
  }

  // 六类证据
  lines.push('    能力证据:')
  if (item.hits.length === 0) {
    lines.push('    - 未命中命令执行、凭据、动态执行等规则')
  } else {
    for (const hit of item.hits) {
      lines.push('    - ' + hit.label + ': ' + String(hit.count) + ' 处')
      for (const sample of hit.samples) lines.push('        ' + clipped(sample, 150))
    }
  }

  const installBits = item.installScripts.length === 0 ? ['无 preinstall/install/postinstall'] : ['有 ' + item.installScripts.join('/')]
  if (item.installActive) installBits.push('脚本内含下载/执行命令')
  if (item.prepare) installBits.push('有 prepare（仅 git 安装时执行）')
  lines.push('    安装期脚本: ' + installBits.join('；'))
  lines.push(
    '    自启动/常驻: ' +
      (item.hits.some((hit) => hit.id === 'persist') ? '命中系统自启动关键词' : '未发现系统级自启动') +
      (item.hits.some((hit) => hit.id === 'server') ? '；有本地服务/定时器' : ''),
  )
  lines.push(
    '    自行外发: ' +
      (item.postExternal
        ? '检测到向外部地址 POST 的路径（需确认是同步/上传/遥测）'
        : endpoints.length > 0
          ? '有出站请求；未检出明显 POST 外发'
          : '未发现'),
  )
  lines.push('    建议:')
  for (const line of item.advice) lines.push('      · ' + line)
  const sampled = item.hosts.filter((host) => host.sample !== '')
  if (detail && sampled.length > 0) {
    lines.push('    网址清单（前 30）:')
    for (const host of sampled.slice(0, 30)) {
      lines.push('      ' + (host.endpoints > 0 ? '[请求] ' : '[文档] ') + clipped(host.sample, 150))
    }
  }
  return lines
}

/**
 * Render the whole report.
 * @param {object} options
 * @param {Array<ReturnType<typeof compactPlugin>>} options.items
 * @param {string} options.home
 * @param {string[]} options.profiles
 * @param {boolean} options.selfSkipped
 * @param {boolean} options.detail
 */
export function renderReportMarkdown(options) {
  const lines = []
  lines.push('# 插件安全审计（只读静态扫描）')
  lines.push('')
  lines.push('- DSH_HOME: ' + options.home)
  lines.push('- 时间: ' + new Date().toISOString())
  lines.push('- 边界: 只读 package.json / README / 入口与源码；不运行被审计代码，不联网，不修改文件。')
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 }
  for (const item of options.items) counts[item.grade] = (counts[item.grade] ?? 0) + 1
  lines.push(
    '扫描 ' + String(options.items.length) + ' 个第三方插件（' + options.profiles.join(', ') + '）：' +
      'S ' + String(counts.S) + ' · A ' + String(counts.A) + ' · B ' + String(counts.B) + ' · C ' + String(counts.C) + ' · D ' + String(counts.D),
  )
  lines.push('评分只用于排序，不是安全证明；请以每个插件下面的证据为准。')
  if (options.selfSkipped) lines.push('（已跳过 dsh-audit 自身：审计自己的规则文本没有意义，本插件不审计自己。）')

  let index = 0
  const sorted = [...options.items].sort((a, b) => a.score - b.score)
  for (const item of sorted) {
    index += 1
    lines.push(...renderPluginMarkdown(item, index, options.detail))
  }

  const risky = sorted.filter((item) => item.grade === 'C' || item.grade === 'D').map((item) => item.name)
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  if (risky.length === 0) {
    lines.push('没有 C/D 级插件；仍需逐条看「能力证据」，尤其是执行本机命令与向外部地址 POST 的路径。')
  } else {
    lines.push('先处理这些：' + risky.join(', ') + '。')
  }
  lines.push('')
  lines.push('官方 @deepseek-ai/* 包随安装包分发，不在本报告范围内。')
  return lines.join('\n')
}

/**
 * Render the pre-install verdict.
 * @param {object} packed - result of auditPreinstall
 */
export function renderPreinstallMarkdown(packed) {
  const item = compactPlugin(packed.result)
  const lines = []
  lines.push('# 安装前审计')
  lines.push('')
  lines.push('- 来源: ' + packed.kind + ' · ' + packed.source)
  lines.push('- 包: ' + (item.name || '(未命名)') + (item.version !== '' ? ' ' + item.version : ''))
  lines.push('- 时间: ' + new Date().toISOString())
  lines.push('- 边界: 只读文本；没有执行包内代码，没有解压到磁盘。')
  lines.push('')
  lines.push('## 结论: ' + item.grade + '（' + item.gradeLabel + '），评分 ' + String(item.score) + '/100')
  lines.push('')
  lines.push(item.grade === 'D' || item.grade === 'C' ? '不建议直接安装。' : '可以安装，但装完请按下面的建议收口。')
  lines.push('')
  lines.push(...renderPluginMarkdown(item, 1, true))
  lines.push('')
  lines.push('## 装上后要关什么')
  if (item.hits.some((hit) => hit.id === 'exec') || item.hits.some((hit) => hit.id === 'server')) {
    lines.push('- 关闭它的命令执行/终端/本地服务入口（如果有设置开关）。')
  }
  if (item.hits.some((hit) => hit.id === 'credentials')) {
    lines.push('- 不要给它主账号密钥；改用单独的低额度 key。')
  }
  if (item.postExternal) lines.push('- 关闭同步/上传/遥测，再用抓包复核。')
  if (item.hits.some((hit) => hit.id === 'persist')) lines.push('- 检查并删除它写入的自启动项。')
  if (item.installScripts.length > 0) lines.push('- 安装时用 --ignore-scripts 或拒绝 build。')
  if (lines[lines.length - 1] === '## 装上后要关什么') lines.push('- 没有发现需要额外关闭的开关。')
  return lines.join('\n')
}
