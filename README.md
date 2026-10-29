# GPT龙娘（DragonGirl Desktop Companion）

![GPT龙娘：桌面陪伴 · 用量一目了然](assets/readme/banner.png)

<p align="center">
  <a href="https://github.com/InhamiRei/Codex-DragonGirl/releases/latest"><img alt="下载最新版" src="https://img.shields.io/github/v/release/InhamiRei/Codex-DragonGirl?label=Release&color=8b72d9" /></a>
  <img alt="Windows 10 / 11 x64" src="https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-587bd8" />
  <img alt="macOS 15+ Apple Silicon" src="https://img.shields.io/badge/macOS-15%2B%20Apple%20Silicon-8272b8" />
  <img alt="作者 Hey、小怪兽" src="https://img.shields.io/badge/作者-Hey、小怪兽-b994e3" />
</p>

一只可以拖动、贴边、轻轻戳一戳的桌面龙娘，也是你的 **Codex 额度与本机用量面板**。让她安静地待在桌面，或者跟随正在使用的窗口；想看额度时点一下，想看账本时打开托盘菜单。

**作者：Hey、小怪兽**

[下载最新版](https://github.com/InhamiRei/Codex-DragonGirl/releases/latest) · [更新日志](CHANGELOG.md) · [反馈问题](https://github.com/InhamiRei/Codex-DragonGirl/issues)

## 她能做什么

- **桌面陪伴**：透明背景、鼠标穿透、拖动吸附、缩放、翻转、自定义角色图片与轻点互动。
- **窗口跟随**：跟随当前 Codex 窗口，多开时可设置每个运行实例一只；最小化后自动隐藏关联角色。
- **额度气泡**：查看实际剩余额度、重置时间和今日 Tokens，用量窗口按服务返回结果展示。
- **多实例总览**：自动发现默认目录、Cockpit 多开目录，也可手动添加；同一账户的共享额度会作提示。
- **本机账本**：按日期、实例、模型、来源筛选，查看模型分布、年度活动热力图和会话明细，支持 CSV / JSON 导出。
- **提醒与声音**：任务完成、异常、低额度和预算提醒；支持原声音效、事件音量、免打扰时段及自定义气泡。
- **本地保存**：设置与统计保存在本机，支持设置导入导出、账本备份和重建。

## 下载与安装

前往 [Releases](https://github.com/InhamiRei/Codex-DragonGirl/releases/latest)，展开 **Assets**，按电脑系统选择文件。运行发行包不需要 Node.js、npm 或工程源码。

| 电脑 | 下载文件 | 打开方法 |
| --- | --- | --- |
| Windows 10 / 11，Intel / AMD 64 位 | `Codex-DragonGirl-1.2.1-Windows-x64.zip` | 完整解压后双击文件夹内的 `DragonGirl.exe` |
| macOS 15+，Apple Silicon | `Codex-DragonGirl-1.2.1-macOS-arm64.dmg` | 把「Codex 龙娘.app」拖入 Applications |
| 同上，偏好 ZIP | `Codex-DragonGirl-1.2.1-macOS-arm64.zip` | 解压后打开 App，或移入 Applications |

Windows 请保留解压后的整个文件夹，程序需要旁边的运行时文件。当前暂未提供 Windows ARM 原生版和 Intel Mac 版。

安装包未作商业代码签名；macOS 包采用 ad-hoc 签名，尚未进行 Apple Developer ID 公证。首次打开可能需要系统确认，请从本仓库 Release 下载并核对附件中的 SHA-256。macOS 若拦截，可在「系统设置 → 隐私与安全性」中允许本应用。

## 第一次使用

1. **先安装并登录 Codex。** 龙娘读取本机已有实例，无需在龙娘里填写密码或 API Key。Windows 如未找到内置 CLI，可安装官方 Codex CLI 后重启龙娘。
2. **打开龙娘。** 管理窗口自动显示发现的账户与目录。首次建立历史账本可能需要几分钟，额度查询独立进行。
3. **选择摆放方式。** 在「偏好设置 → 外观」选择跟随窗口或独立桌面；右键角色可恢复位置、调整大小或进入管理界面。
4. **轻点试听。** 九段原声音效已随应用附带，首次打开即可离线播放，无需下载。可在「偏好设置 → 声音」调整音量或修复音效。
5. **查看用量。** 轻点龙娘打开气泡；点击托盘 / 菜单栏图标打开账户总览、用量账本和偏好设置。

显示 / 隐藏主龙娘的快捷键：macOS 为 `⌘⌥⇧D`，Windows 为 `Ctrl+Alt+Shift+D`。也可使用右键菜单操作。

Windows 跟随针对同一系统用户运行的 Codex / ChatGPT 桌面窗口。受系统权限保护或以其他用户运行的进程可能无法识别，可切换独立桌面模式，并手动添加目录。WSL 内部的独立账户和 Linux 窗口暂不作自动映射。

## 更新内容

### v1.2.1

- **修复**：九段原声直接随安装包附带，新电脑首次打开即可离线播放，无需手动下载。
- **修复**：声音设置识别内置原声，旧版本机音频损坏时自动使用有效的内置副本。
- **完善**：离线修复后立即恢复播放，构建与桌面验收检查内置音效完整性和点击播放。

升级：退出旧版，下载对应系统的新版本并替换应用文件。设置和账本保存在独立用户目录中；Windows 可将新版解压到新文件夹后启动。

<details>
<summary>详细说明：统计口径与数据保存</summary>

### 统计口径

- **账户额度**来自各实例的官方账户接口，保留实际返回的计量桶、窗口长度、重置时间和重置卡。未知、断网、过期与真实零值分别显示。
- **本机用量**来自 `sessions/`、`archived_sessions/` 的本地日志及 Zstandard 归档；支持请求记录和旧格式累计差分，缓存与推理分项不重复计入总量。
- **参考费用**是接口等价估算，不能替代订阅账单。未知模型和未经核对的历史价格保持未定价，可在设置中补充价格。
- **任务提醒**依据日志中的真实事件触发，不推测未观测到的等待和授权状态。
- 手动刷新等待账户查询和增量索引结束后显示结果；共享账户的多个目录不能作为多份独立额度相加。

### 用户数据目录

| 系统 | 位置 |
| --- | --- |
| Windows | `%APPDATA%\Codex DragonGirl\` |
| macOS | `~/Library/Application Support/Codex DragonGirl/` |

目录包含 `preferences.json`、`settings.json`、`usage.sqlite`、最近额度快照和本机角色 / 音效文件。索引只保存统计字段，不保存对话正文、回答或工具输出；发行包不包含作者的账户、会话和数据库。

龙娘不会修改原始会话日志。官方 CLI 自身可能按其正常规则刷新登录缓存。删除龙娘用户数据目录会清除龙娘的设置和账本；升级时保留此目录即可。

</details>

## 开发与构建

需要 Node.js 24+。Windows 构建使用系统内置 .NET Framework 编译器；macOS 原生桥需要 Xcode Command Line Tools。

```sh
npm ci
npm run build:native
npm start
```

```sh
# 通用检查
node scripts/fetch-reference-audio.mjs
npm run check
npm test

# Windows x64：在 Windows 或 GitHub Actions 中执行
npm run test:windows
npm run package:win
npm run verify:windows

# Apple Silicon macOS
npm run test:desktop
npm run test:app
npm run package:mac
npm run verify:package
```

声音测试使用隔离目录中的原声音效；首次运行测试前需准备上述音效缓存。构建输出位于 `output/`，测试报告位于 `.artifacts/`，两者均不进入源码仓库。Windows Actions 验证原生窗口、统计和解压后的独立应用，并保留构建产物。

## 素材与致谢

原声音效来自 [DeepSeek Balance Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，九段原声随应用附带，来源、文件校验和权利说明见 [音效来源](docs/音效来源.md)。第三方音频不标为本项目原创，也不另行授予素材许可。
