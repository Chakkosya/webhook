# Browser Workflow

AI 在场外学习、诊断和修补，确定性引擎执行已验证工作流。站点类型由实际学习资料确定；WHMCS 是一个可选适配器。

## 启动

需要 Node.js 24 和 Chromium。

```bash
npm ci --ignore-scripts
node node_modules/playwright-core/cli.js install chromium
npm start
```

打开 <http://127.0.0.1:3000>。尚未确定目标站点时，可以启动工作台。配置和学习资料补齐后，再登录、试运行与发布。

工作台按概况、登录账户、工作流仓库、执行记录和购买配置分别显示。导航支持刷新与前进后退，切换页面保留未保存的表单内容。工作流和执行记录每页显示 10 条。

Windows PowerShell 可使用 `npm.cmd`。已安装浏览器可通过 `BROWSER_EXECUTABLE` 指定。数据默认保存在 `.data/workflow`，可用 `DATA_DIR` 更改。

## 接入实际站点

1. 确定商品链接，采集成功操作记录和实测耗时。
2. 填写 `examples/config.template.json`。已学习的原生表单或动作链接使用 `adapter: "learned"`；WHMCS 可使用 `examples/whmcs.config.template.json`。
3. 录入实际的登录、库存、报价、订单记录和提交结果证据。在工作台“登录账户”中保存账号密码并登录。订单标识可包含字母和数字。
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
| `src/safety` | 一次性许可、持久化防重放、预算门禁、本地与商家判重 |
| `src/browser` | 常驻浏览器、账户会话、保活、请求门禁、进展检测 |
| `src/workflow` | 声明式工作流、版本、diff、发布、回滚、准入和统计 |
| `src/engine` | 前置检查 → 动作 → 后置验证，零推理 |
| `src/adapters/learned` | 执行本站点已学习的库存、报价、订单和付款证据 |
| `src/adapters/whmcs` | WHMCS 的数字账单标识与账单链接约定 |
| `src/monitor` | 浏览器只读监控、即时双确认、单次触发 |
| `src/extractor` | 成功轨迹清洗、参数化、成功耗时提炼 |
| `src/ai` | 独立进程中的生成、诊断和修补 |
| `src/locators` | 选择器与图像锚点降级，按实际定位成功率排序 |
| `src/healthcheck` | SSH 购后 CPU、IO、网络与路由检查 |

账号密码按站点和账户加密保存，密码不回显。浏览器启动时恢复会话、登录和预热，之后定时检测掉线并自动重登。更换登录账号后需要重新试运行。工作流 JSON 不运行脚本。每个真实写请求都核对地址、方法与完整表单值，许可在放行网络前消费。未核验的写操作保留未知状态，进程重启后也不能自动重放。

超时取对应成功样本的最大值再加明确余量。网络收包和页面内容变化更新进展时间；无进展上限与绝对上限分别约束等待。监控与下单使用独立策略。

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

从源码构建：

```bash
docker compose -f compose.build.yaml up -d --build
```

容器包含匹配版本的 Chromium 和 Xvfb，工作台默认仅绑定本机。持久化卷保存数据库、浏览器配置和图像锚点。GitHub Actions 在全量测试、只读容器浏览器检查和启动检查通过后发布镜像。

[站点学习与操作说明](docs/operations.md)包含字段约定、场外 AI 配置、人工处理和 API。

## 已知限制

- 接入每个真实站点都需要实际页面、成功操作与实测耗时；未学习、未验证的站点不能真实下单。
- 当前执行原生表单和原生动作链接。依赖自定义 JavaScript 提交的页面需要补充本站点请求适配。
- 下单前必须能核实账户登录状态并完整读取商家订单记录。
- 自动付款仅支持已学习的账户余额付款；外部收银台、扫码与二次验证交由人工处理。
- 需要人工交互的人机验证由操作员在登录窗口完成。
- 图像锚点适用于相同缩放与相近布局；大幅改版需要重新采集。
