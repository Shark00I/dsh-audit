/**
 * Static rules, scoring and grading for dsh-audit.
 *
 * Everything here is data, not behaviour: the scanner reads files, the rules
 * decide what a match means, and `grade()` turns evidence into a score. Adding
 * a rule never requires touching the runtime, which is the extension seam the
 * README documents.
 */

/** Every static evidence rule. `weight` is the score cost when it matches. */
export const RULES = [
  {
    id: 'exec',
    label: '执行本机命令',
    weight: 10,
    tag: 'exec',
    re: /node:child_process|from ['"]child_process['"]|\bexecFile(Sync)?\s*\(|\bexecSync\s*\(|\bspawn(Sync)?\s*\(|\bshell\.exec\b/,
  },
  {
    id: 'eval',
    label: '动态执行代码',
    weight: 25,
    tag: 'eval',
    re: /\beval\s*\(|new\s+Function\s*\(|vm\.runIn|runInNewContext|runInThisContext/,
  },
  {
    id: 'decode',
    label: '解码后执行（加密/Base64）',
    weight: 8,
    tag: 'obfuscated',
    re: /Buffer\.from\([^)]{0,80}['"]base64['"]|atob\s*\(|createDecipheriv|\bXOR\b/,
  },
  {
    id: 'credentials',
    label: '触碰密钥/凭据',
    weight: 3,
    tag: 'credentials',
    re: /credentials\.(resolve|set|delete|readRecord)|api[_-]?key|Authorization\s*[:=]|Bearer\s|\.npmrc|\.ssh\b|id_rsa|\.aws\b|keychain|secret[_-]?key/i,
  },
  {
    id: 'fs-write',
    label: '写入或删除文件',
    weight: 2,
    tag: 'write',
    re: /\b(writeFile|appendFile|unlink|rmSync|rmdir|rename|mkdir|createWriteStream)\s*\(|\bfs\.rm\b|node:fs/,
  },
  {
    id: 'fs-read',
    label: '读取本地文件',
    weight: 0,
    tag: 'read',
    re: /\b(readFile|readdir|readFileSync|readdirSync|createReadStream)\s*\(|\bos\.homedir\s*\(/,
  },
  {
    id: 'net',
    label: '发起网络请求',
    weight: 0,
    tag: 'network',
    re: /\bfetch\s*\(|https?\.request\s*\(|\baxios\b|new\s+WebSocket\s*\(|sendBeacon|undici/,
  },
  {
    id: 'server',
    label: '本地服务/常驻定时器',
    weight: 3,
    tag: 'server',
    re: /\bcreateServer\s*\(|new\s+WebSocketServer|\.listen\s*\(|\bsetInterval\s*\(/,
  },
  {
    id: 'persist',
    label: '系统自启动',
    weight: 12,
    tag: 'autostart',
    re: /schtasks\s+\/create|CurrentVersion\\+Run|LaunchAgents|systemctl\s+enable|pm2\s+(start|save)|autostart|crontab\s+-e|launchctl\s+(load|bootstrap)/i,
  },
  {
    id: 'native',
    label: '原生二进制模块',
    weight: 4,
    tag: 'native',
    re: /\.node['"]|binding\.gyp|node-gyp|node-pre-gyp|prebuild-install/,
  },
  {
    id: 'obfuscation',
    label: '混淆/压缩代码',
    weight: 12,
    tag: 'obfuscated',
    re: /_0x[0-9a-f]{3,}|eval\([^)]{0,40}\\x[0-9a-f]{2}|\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i,
  },
]

/** Install-time script keys that run during `pnpm add`. */
export const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall']

/** A script body that downloads or runs something during install. */
export const INSTALL_ACTIVE_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|npm\s+(i|install)|pnpm\s+(i|install)|yarn\s+(add|install)|node\s+-e|powershell|bash\s+-c|sh\s+-c)\b/i

/** Grade thresholds, highest first. */
export const GRADES = [
  { grade: 'S', min: 90, label: '低风险', tone: 'safe', advice: '可放心安装；保持默认设置。' },
  { grade: 'A', min: 75, label: '可接受', tone: 'ok', advice: '可安装，装后按建议收口。' },
  { grade: 'B', min: 60, label: '需留意', tone: 'notice', advice: '先读证据，确认它确实需要这些能力。' },
  { grade: 'C', min: 40, label: '谨慎', tone: 'watch', advice: '谨慎安装；逐条核对命令执行与外发地址。' },
  { grade: 'D', min: 0, label: '高风险', tone: 'danger', advice: '不建议安装；除非你完全信任作者与来源。' },
]

/** Map a 0–100 score to its grade row. */
export function grade(score) {
  for (const row of GRADES) if (score >= row.min) return row
  return GRADES[GRADES.length - 1]
}

/** Domains that never count as "data leaves this machine". */
export const LOCAL_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', 'dsh.internal', 'example.com', 'example.org',
])

/** Hosts treated as local or reserved (never "data left this machine"). */
export function isLocalHost(host) {
  if (LOCAL_HOSTS.has(host)) return true
  if (host === '::1' || host.startsWith('127.') || host.endsWith('.localhost')) return true
  return /(^|\.)example\.(com|org|net)$/.test(host) || /(^|\.)(example|test|invalid|localhost)$/.test(host)
}
