# Browser Workflow

AI 在场外学习、诊断和修补，确定性引擎执行已验证工作流。站点类型由实际学习资料确定；WHMCS 是一个可选适配器。

## 启动

需要 Node.js 24 和 Chromium。

```bash
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium
npm start
```

打开 <http://127.0.0.1:3000>，通过右上角 **Sign Up** 创建首个管理员。之后使用 **Sign In** 登录工作台。管理员接管当前数据目录中的已有配置；其他用户拥有独立的任务、账号、API、出口和浏览器会话。

工作台提供监控任务、API 与出口、工作流仓库、执行记录和购买配置入口。商家账号在各监控任务内管理；右上角邮箱打开工作台账户设置。导航支持刷新与前进后退，切换页面保留未保存的表单内容。监控、工作流和执行记录每页显示 10 条。

Windows PowerShell 可使用 `npm.cmd`。已安装浏览器可通过 `BROWSER_EXECUTABLE` 指定。数据默认保存在 `.data/workflow`，可用 `DATA_DIR` 更改。

## 邮箱注册与网站登录

首次管理员通过邮箱和密码创建，不依赖发信服务。管理员点击右上角邮箱 →「邮件注册设置」，选择 Resend 或 SMTP，填写发件人和服务凭据。密钥与 SMTP 密码加密保存，不回显。配置后，其他用户在 Sign Up 页面接收六位验证码，10 分钟内完成注册。密码至少 8 个字符，使用独立盐值的 scrypt 保存；登录会话通过 HttpOnly Cookie 持久化，退出后立即失效。

也可通过 `RESEND_API_KEY`、`MAIL_FROM` 或 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`MAIL_FROM` 配置。SMTP 的 465 端口使用 SSL，587 通常使用 STARTTLS；发信域名和发件人须符合所选服务的要求。参见 [SMTP 配置](https://nodemailer.com/smtp) 和 [Resend 发信接口](https://resend.com/docs/api-reference/emails/send-email)。

## 创建监控（无需代码）

1. 打开「API 与出口」→「AI API」，填写名称、API 地址、API Key 和模型名称，保存后点击「测试连接」。可以保存多个服务并设置默认 API。
2. 需要代理时，切换到「网络出口」，粘贴 SS 分享链接或手填 SS 节点，也可添加 HTTP / HTTPS 代理。点击「测试出口」核对浏览器连通性与出口 IP。
3. 打开「监控任务」→「新建监控」，粘贴网页地址，选择补货、价格、内容变化或关键词，用一句话说明要求，选择 API、出口和检查间隔。
4. 登录可见的网页：在任务内切换「商家账户」，添加商家登录网址、账号、密码和备注，勾选一个或多个账户。可逐个检测登录。每个账户有独立持久浏览器会话，掉登录后按实际页面学到的表单重新登录；多个账户同时检查，结果与提醒分别记录。公开页面可不添加账户。
5. 点击「AI 分析并预览」。系统打开真实浏览器，提取页面证据，生成规则并连续验证两次。核对当前读取内容和触发条件后，点击「确认并启动监控」。
6. 在任务卡片中暂停、立即检查、管理账户、重新配置或删除。修改账号或参与监控的账户选择后，需要重新分析验证。支持多个任务，每页 10 条。配置和运行状态持久化，服务重启后恢复已启用的监控。

日常检查只运行已经验证的规则，不调用 AI。命中时立即再读取一次，确认后记录提醒；通知地址选填，填写时发送通用 JSON Webhook。异常页、登录页或目标元素缺失返回未知，库存只接受明确数字或完整可用的加购表单。

SS Docker 客户端来自 [shadowsocks-rust](https://github.com/shadowsocks/shadowsocks-rust)，节点分享链接遵循 [SIP002](https://shadowsocks.org/doc/sip002.html)。本机运行 SS 时需安装客户端并设置 `SSLOCAL_EXECUTABLE`。API 密钥、SS 密码和通知地址在数据库中加密保存，接口不回显密钥和密码。

## 接入实际站点（下单工作流）

1. 确定商品链接，采集成功操作记录和实测耗时。
2. 填写 `examples/config.template.json`。已学习的原生表单或动作链接使用 `adapter: "learned"`；WHMCS 可使用 `examples/whmcs.config.template.json`。
3. 录入实际的登录、库存、报价、订单记录和提交结果证据。在「站点与购买配置」→「购买工作流的登录与会话」中保存该购买流程的站点账号。订单标识可包含字母和数字。
4. 导入工作流，同一版本、同一参数连续试运行通过两次后发布。
5. 直接执行或启用浏览器双确认补货监控。

```bash
npm run cli -- configure --file config.json
npm run cli -- login
npm run cli -- import --file learned-workflow.json
npm run cli -- trial --id product-order --version 1
npm run cli -- trial --id product-order --version 1
npm run cli -- publish --id product-order --version 1
npm run cli -- watch --id product-order --version 1 --mode live
```

`goal: "invoice"` 表示创建订单或账单后停止，由人工继续支付。`goal: "pay"` 表示创建后执行已学习的余额付款流程。余额不足可创建待支付订单；自动余额付款在提交前检查余额。

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/auth` | 网站邮箱注册、密码登录、持久会话和发信设置 |
| `src/safety` | 一次性许可、持久化防重放、预算门禁、本地与商家判重 |
| `src/browser` | 常驻浏览器、账户会话、保活、请求门禁、进展检测 |
| `src/workflow` | 声明式工作流、版本、diff、发布、回滚、准入和统计 |
| `src/engine` | 前置检查 → 动作 → 后置验证，零推理 |
| `src/adapters/learned` | 执行本站点已学习的库存、报价、订单和付款证据 |
| `src/adapters/whmcs` | WHMCS 的数字账单标识与账单链接约定 |
| `src/monitor` | 浏览器只读监控、即时双确认、单次触发 |
| `src/extractor` | 成功轨迹清洗、参数化、成功耗时提炼 |
| `src/ai` | 场外生成监控规则、诊断和修补；支持保存的 API 与独立命令 |
| `src/workspace` | API、出口与监控配置的加密持久化 |
| `src/locators` | 选择器与图像锚点降级，按实际定位成功率排序 |
| `src/healthcheck` | SSH 购后 CPU、IO、网络与路由检查 |

账号密码按站点和账户加密保存，密码不回显。浏览器启动时恢复会话、登录和预热，之后定时检测掉线并自动重登。更换登录账号后需要重新试运行。工作流 JSON 不运行脚本。每个真实写请求都核对地址、方法与完整表单值，许可在放行网络前消费。未核验的写操作保留未知状态，进程重启后也不能自动重放。

超时取对应成功样本的最大值再加明确余量。网络收包和页面内容变化更新进展时间；无进展上限与绝对上限分别约束等待。监控与下单使用独立策略。

## 双定位工作流

工作流仓库的「采集双定位」会执行一次只读试运行，为每个操作保存真实元素选择器和截图锚点，生成待验证版本。新版本连续试运行通过两次后才能发布。定位先尝试选择器，失败一次立即转本地截图匹配；每次定位结果计入统计，后续按实际成功率排序。执行步骤记录实际使用的定位方式。视觉定位不重复发送动作，也不绕过操作许可。

当前提取器使用本项目的成功执行轨迹；未直接集成 [Skyvern](https://github.com/Skyvern-AI/skyvern) SDK 或其视觉模型。视觉降级使用本地截图模板匹配，不调用推理服务。Skyvern 等工具的操作记录可用于场外学习资料，仍需本站点的语义、请求和两次试运行验证。

## 验证与统计

```bash
npm run test:safety
npm test
```

测试使用真实 Chromium，分别覆盖 WHMCS 和独立商城。独立商城使用中文库存、POST 购物车和字母数字订单号。两条链路都统计实际请求，验证两次试跑准入、预算、商家判重和提交凭证。

每次执行保存版本、步骤耗时、定位方式、核验结果、原始错误链和推理调用数。真实执行统计与试运行分开。连续三次失败的工作流标为过期，重新学习后发布新版本。

## 部署

镜像：`ghcr.io/chakkosya/webhook:latest`。发布同时提供 `sha-<提交前12位>` 固定标签。

```bash
docker compose pull
docker compose up -d
```

通过 1Panel / OpenResty 或 Nginx 反向代理时，可直接使用 HTTPS 域名访问。浏览器的同源请求在代理改写 Host 后仍可正常注册、登录和保存配置；不提供浏览器来源元数据的客户端，使用代理转发的外部域名与协议核对来源。代理应覆盖这些请求头，并让应用端口仅对本机或代理网络开放：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
```

从源码构建：

```bash
docker compose -f compose.build.yaml up -d --build
```

容器包含匹配版本的 Chromium、Xvfb 和 SS 客户端，工作台默认仅绑定本机。持久化卷保存数据库、浏览器配置和图像锚点。GitHub Actions 在全量测试、只读容器浏览器检查和启动检查通过后发布镜像。

[站点学习与操作说明](docs/operations.md)包含字段约定、场外 AI 配置、人工处理和 API。

## 已知限制

- 智能监控需要可重复读取的页面证据；缺少库存强信号时不会推断有货。任务登录当前支持同站点原生 POST 账号密码表单，以真实页面的退出入口核验登录；短信、二次验证、人机验证码及自定义 JavaScript 登录需要补充站点学习，不能自动跳过。
- 接入每个真实站点都需要实际页面、成功操作与实测耗时；未学习、未验证的站点不能真实下单。
- 当前执行原生表单和原生动作链接。依赖自定义 JavaScript 提交的页面需要补充本站点请求适配。
- 下单前必须能核实账户登录状态并完整读取商家订单记录。
- 自动付款仅支持已学习的账户余额付款；外部收银台、扫码与二次验证交由人工处理。
- 需要人工交互的人机验证由操作员在登录窗口完成。
- 图像锚点适用于相同缩放与相近布局；大幅改版需要重新采集。
