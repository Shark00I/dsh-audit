# dsh-audit · 审计台

**当前版本 1.0.0（2026-10-28 首发，更新 1 次）**

给 DeepSeek Harness 用的插件审计台：装之前先看它安不安全，装之后看它做了什么。

- **安装前审计**：本地目录 / `.tgz` / `.tar.gz` / npm 包名 / https 压缩包，只读文本，不执行、不解压到磁盘。
- **分级评分**：每个第三方插件一个 S–D 等级和 0–100 分，附证据（数据去向、命令执行、凭据、自启动、外发、安装脚本）。
- **运行时监控**：记录插件启停时间、敏感操作（删除/写入文件、运行程序、网络外发、读写凭据、插件管理）与这些工具调用的 token 估算。
- **设置面板**：设置 → 审计，包含评分、运行时时间线、错误日志、安装前检查、监控开关。
- **不审计自己**：dsh-audit 在扫描与监控中跳过自身。

> 边界：审计只读文本，不 import、不执行被审计的插件；不联网扫描已安装插件；运行时监控不发任何网络请求，数据只落在本机 `$DSH_HOME/dsh-audit/`。

---

## 系统环境

| 项 | 要求 |
| --- | --- |
| DSH | `>= 0.2.1-rc.0`（桌面版与 `dsh web` 均可） |
| Node | `>= 20`（DSH 自带的 Node 即可） |
| 系统 | Windows 10+ / macOS 12+ / Linux（无原生依赖，纯 ESM） |
| 依赖 | 零运行时 npm 依赖；`@deepseek-ai/*` 由宿主提供 |

插件不安装任何 npm 包，也不需要编译。`package.json` 只有 `dsh.bundle.patch` 与 `dsh.client` 两段声明。

---

## 安装

### 桌面版

应用内打开 **插件（Plugins）→ 安装 / 添加插件**，选择 `dsh-audit` 的目录或压缩包；也可以把目录放到任意位置后：

```sh
dsh plugin --profile desktop add link:<dsh-audit 的绝对路径>
```

### 普通 `dsh web`

```sh
dsh plugin --profile web add dsh-audit        # 发布到 npm 之后
dsh plugin --profile web add link:<绝对路径>   # 本地目录
```

装好后打开 **设置 → 审计**；不需要重启（HMR 会重载插件行）。如果页面没出现新条目，刷新一次浏览器。

---

## 使用

### 1. 设置面板

**设置 → 审计** 有五个页签：

| 页签 | 内容 |
| --- | --- |
| 插件评分 | 每个第三方插件的 S–D 等级、分数条、证据标签；点开看数据去向、安装脚本、自启动、外发、采样行与建议 |
| 运行时 | 正在运行的插件、每个插件的工具 token 估算、启停/敏感操作/安装变化的时间线 |
| 错误 | 插件加载失败、工具错误、会话错误 |
| 安装前检查 | 输入目录/压缩包/npm 包名，当场出结论：能不能装、装后关什么 |
| 设置 | 监控开关、敏感操作开关、启动自动扫描、排除名单、npm 源、清空事件 |

### 2. 给 AI 用的工具

```
plugin_audit                审计已安装插件（profile? plugin? detail?）
plugin_audit_preinstall     审计尚未安装的目标（target: 目录/压缩包/npm 包/https tarball）
```

`plugin_audit` 返回 Markdown 报告：总览 → 每个插件的等级/分数/证据 → 结论。`detail: false` 可关掉网址清单。

`plugin_audit_preinstall` 的输出包含「装上后要关什么」。

### 3. HTTP API（面板自己用的，也是给其他插件/脚本的接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-audit/api/state` | 版本、设置、最近一次扫描、事件、错误、运行中插件 |
| GET | `/dsh-audit/api/events?limit=&type=&plugin=` | 事件与错误 |
| POST | `/dsh-audit/api/scan` | 触发扫描（同源） |
| POST | `/dsh-audit/api/preinstall` | `{ target }` 安装前审计（同源） |
| POST | `/dsh-audit/api/settings` | `{ patch }` 改设置（同源） |
| POST | `/dsh-audit/api/clear` | 清空事件与错误（同源） |

---

## 分级评分制度

分数从 100 往下扣，等级按分数落档。评分只用于排序，**不是安全证明**，结论以证据为准。

| 等级 | 分数 | 含义 | 建议 |
| --- | --- | --- | --- |
| **S** | 90–100 | 低风险 | 可放心安装 |
| **A** | 75–89 | 可接受 | 可安装，装后按建议收口 |
| **B** | 60–74 | 需留意 | 先读证据，确认它确实需要这些能力 |
| **C** | 40–59 | 谨慎 | 逐条核对命令执行与外发地址 |
| **D** | 0–39 | 高风险 | 不建议安装，除非完全信任作者与来源 |

主要扣分项：

| 证据 | 扣分 |
| --- | --- |
| `eval` / `new Function` / `vm.runIn*` | −25 |
| 系统自启动（schtasks / Run / LaunchAgents / systemctl enable / pm2 start / launchctl） | −12 |
| 混淆/压缩代码特征 | −12 |
| `child_process` / `spawn` / `exec` | −10 |
| 安装脚本（preinstall/install/postinstall） | −10 |
| 安装脚本内含下载/执行命令 | −10 |
| 向外部地址 POST / PUT / PATCH | −10 |
| Base64/解密后执行（与 exec/eval 组合再 −8） | −8 |
| 原生模块（`.node`、binding.gyp） | −4 |
| 凭据关键词（apiKey/Authorization/.ssh/.npmrc…） | −3 |
| 本地服务 / `setInterval` | −3 |
| 文件写入/删除 | −2 |
| 凭据 + 外部域名组合 | −4 |
| 扫描体积 > 5 MB | −2 |

降噪规则：README/注释、多语言文案文件、压缩成单行的 bundle、bundle 自带的安装脚本，不参与词法规则（仍提取网址）。

---

## 运行时监控

记录三类事实，其他一律不记：

1. **插件启停**：`internal/status` 进入/离开 ACTIVE 时记一条，含运行时长。
2. **敏感操作**：`tools/pre-execute` + `tools/result`，只对命中规则的调用记录：
   - `pwsh` / `bash` / `terminal_*` 命令里的删除、写入、运行程序、网络外发、凭据读取；
   - `write` / `edit` 的文件路径；
   - `plugin_manager` 的安装/卸载/启停；
   - `web_fetch` / `web_search` 的目标。
3. **token 估算**：这些工具调用的参数 + 结果文本按 4 字符/token 估算，归因到注册该工具的插件（工具归属由插件启停时的注册表快照差分建立）。

不记录普通读取、搜索、渲染等调用；不轮询；不监听文件；事件进内存环形缓冲（600 条），每 3 秒或 80 条批量追加到 `$DSH_HOME/dsh-audit/events.jsonl`（5 MB 滚动一次）。空闲时开销接近 0。

**关于「插件消耗的 token」**：插件本身不调用大模型，真正计费的是会话里的 LLM 调用。这里统计的是「该插件注册的工具被调用时产生的 token 估算」，不是插件自身的开销；没有注册工具或被调用时显示 0。

---

## 安装前审计能做什么、不能做什么

能做：

- 看 `package.json`（scripts、依赖、engines、仓库地址）；
- 看 README 里声明的域名；
- 看入口与全部源码文件里出现的网址、命令执行、凭据读取、动态执行、自启动、外发路径；
- 对 npm 包名：只下载 tarball 到内存，按 tar 格式解析，不落盘。

不能做：

- 压缩/混淆后的代码、运行时拼接的 URL、`import()` 动态加载、原生 `.node` 二进制内部行为；
- 依赖包内部的行为（`node_modules` 不展开）；
- 证明「安全」。评分低不等于恶意，评分高也不等于安全。

---

## 扩展接口

插件激活后提供 `ctx.audit`（Cordis service，随插件卸载自动移除）：

```js
// 1. 增加一条静态规则（影响之后的扫描）
ctx.audit.registerRule({
  id: 'my-rule',
  label: '我的规则',
  weight: 6,
  tag: 'custom',
  re: /my-pattern/,
})

// 2. 订阅运行时事件
const off = ctx.audit.onEvent((event) => {
  // event.type: plugin.start | plugin.stop | sensitive | manager | scan | preinstall | error
})

// 3. 记录自定义事件 / 错误
ctx.audit.record({ type: 'custom', plugin: 'my-plugin', detail: 'did something' })
ctx.audit.recordError({ message: 'boom' })

// 4. 主动扫描 / 安装前审计
const scan = await ctx.audit.scan()
const packed = await ctx.audit.preinstall('some-package@1.2.3')
```

规则表在 `lib/rules.js`，评分在 `lib/scan.js` 的 `scoreOf()`，运行时判定在 `lib/runtime.js` 的 `classifyCall()`——都是独立文件，改完重启 DSH 生效（HMR 不监听 profile 外的目录）。

---

## 数据与隐私

- 所有数据只写 `$DSH_HOME/dsh-audit/`：`settings.json`、`scan.json`、`events.jsonl`、`errors.jsonl`。
- 不发任何网络请求；安装前审计的下载只在你主动输入 npm 包名/https 地址时发生，直接打 `registry.npmjs.org` 或你设置的源。
- 不上传报告，不写遥测。
- 审计对象是**文本**：不 import、不 require、不 eval 被审计插件的任何内容。

---

## 目录

```
dsh-audit/
├── package.json            # dsh.bundle.patch + dsh.client
├── cordis.patch.yml        # 挂载 id: dsh-audit
├── index.js                # Host：扫描/监控/工具/路由/服务
├── client.js               # Client：设置页
├── lib/
│   ├── rules.js            # 规则、权重、分级
│   ├── scan.js             # 静态审计引擎
│   ├── preinstall.js       # 安装前审计（目录/压缩包/npm/URL）
│   ├── tar.js              # 内存 tar 解析
│   ├── runtime.js          # 运行时监控与 token 估算
│   ├── store.js            # 环形缓冲 + 批量落盘
│   └── report.js           # Markdown 报告
├── locale/{en,zh}.json     # 插件列表里的标题/描述
├── icon.svg
├── README.md / README.zh.md
├── CHANGELOG.md
└── LICENSE
```

---

## 开发与发布

```sh
# 本地试装（桌面版请用应用内插件页）
dsh plugin --profile desktop add link:<绝对路径>

# 只改了这个仓库、想临时试一下不改 profile
dsh web --patch "<绝对路径>/dev.patch.yml"
```

发布到 npm：

```sh
npm publish --access public
```

上架插件市场：市场目录来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，在那边提一个 PR 加一行条目；市场页和网站会自动收录。本仓库同时提供 GitHub 可读的 README、CHANGELOG 与 LICENSE，克隆后 `dsh plugin add link:<目录>` 即可使用。

发布前自检：

```sh
node --check index.js
node --check client.js
node --check lib/*.js
npm pack --dry-run        # 确认 files 列表完整
```

---

## 限制

- 静态扫描存在固有误报/漏报（见上）。
- 运行时只能看到「经由 DSH 工具」的操作；插件直接调用 `fs` / `child_process` / `fetch` 的行为不会被这个监控看到（那需要操作系统级审计）。
- 工具归属是启发式：插件在激活时注册的工具能被正确归因；启动前就已存在的工具不会追溯归因。
- 不支持 macOS/Linux 上未验证的路径假设；所有路径都用 `node:path` 拼接。

---

## 许可

MIT。见 [LICENSE](LICENSE)。
