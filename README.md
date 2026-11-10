# JIRA 工时填报

Electron 桌面工作台，支持按天填报、周笔记批量编辑、月度工单绑定、逐条提交及个人填报记录。

运行需要 Node.js 22 和已安装依赖。

```sh
npm install
npm start
```

在「连接与配置」填写 JIRA 地址、用户名和个人 API Token，测试后保存。凭据使用当前操作系统保护，普通工作台数据按站点和账号保存在 Electron userData。周笔记可从「批量填报」选择文件夹。Agent 可以稍后配置，默认或自定义服务通过各 CLI 检测后启用。

首次从源码接入自己的站点前，将 `app/site-defaults.example.json` 复制为 `app/site-defaults.local.json`，把 `projectKey` 改为目标 JIRA 项目标识。该本机文件已被 Git 忽略，不要提交真实公司地址或个人信息。公开示例使用虚构项目 `DEMO`；已有连接会保留其已保存的项目，旧配置未保存项目时沿用本机配置，以继续读取原有草稿和历史。

`trustedModelOrigins` 只填写经过核实、允许处理真实工作事项的 HTTPS 模型服务来源（例如 `https://models.example.test`，不带 `/v1` 路径），默认空数组。模型服务地址、模型名和密钥仍在应用内配置。`notesRelativeDirectory` 为文档目录下的相对文件夹，可留空；非空时应用尝试查找其中的「当前年份工作安排」文件夹，用户也可直接从应用选择笔记目录。

本机配置会随源码打包进入自己的安装包；分发应用前应核对该文件。JIRA Token 和模型密钥继续保存在操作系统保护的运行数据中。

```sh
npm test
npm run package:mac
npm run package:mac:intel
npm run package:win
```

制品输出到 dist。Windows 包需要在 Windows 实机执行验收。源码导览、公开范围和验证说明见 [项目文档索引](docs/README.md)。

`package:mac` 对应 Apple 芯片（arm64），`package:mac:intel` 对应 Intel 芯片（x64），`package:win` 对应 Windows x64。各平台同时输出可分发 ZIP。Windows 解压完整文件夹后运行其中的 `JIRA工时填报.exe`；Mac 解压后运行 `.app`。

AI 功能需要目标电脑已安装 DSH CLI 或 Codex CLI，并完成登录或模型服务配置。应用查找 PATH、用户 `.local/bin`，Windows 额外查找 `%APPDATA%\npm`；Windows 支持 `.exe`、`.com`、`.cmd`、`.bat` 入口。未发现时可在「连接与配置」手动选择程序，再检测并保存。CLI、账号登录和 API Key 不随安装包迁移。真实事项的 AI 建议沿用现有约束，需要已核实的自定义内部模型服务；手动填报可独立使用。

macOS Apple 芯片打包路径为 `dist/JIRA工时填报-darwin-arm64/JIRA工时填报.app`。双击应用即可打开；首次运行未签名制品时，按 macOS 的正常应用打开方式处理。源码启动使用上方 `npm start`。仓库不附带构建产物。

当前实现面向 JIRA Server 7.5.2 与 Tempo 的产品工时类型，并保留特定工单类型、自定义字段和子任务规则。其他站点需要先核对适配条件。macOS 已进行实际使用验证；Windows 尚未实机验收。
