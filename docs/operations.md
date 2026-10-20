# 站点学习与运行

## 创建监控（无需代码）

1. 打开「API 与出口」→「AI API」，填写名称、API 地址、API Key 和模型名称，保存后点击「测试连接」。可以保存多个服务并设置默认 API。
2. 需要代理时，切换到「网络出口」，粘贴 SS 分享链接或手填 SS 节点，也可添加 HTTP / HTTPS 代理。点击「测试出口」核对浏览器连通性与出口 IP。
3. 打开「监控任务」→「新建监控」，粘贴网页地址，选择补货、价格、内容变化或关键词，用一句话说明要求，选择 API、出口和检查间隔。
4. 点击「AI 分析并预览」。系统打开真实浏览器，提取页面证据，生成规则并连续验证两次。核对当前读取内容和触发条件后，点击「确认并启动监控」。
5. 在任务卡片中暂停、立即检查、重新配置或删除。支持多个任务，每页 10 条。配置和运行状态持久化，服务重启后恢复已启用的监控。

日常检查只运行已经验证的规则，不调用 AI。命中时立即再读取一次，确认后记录提醒；通知地址选填，填写时发送通用 JSON Webhook。异常页、登录页或目标元素缺失返回未知，库存只接受明确数字或完整可用的加购表单。

SS Docker 客户端来自 [shadowsocks-rust](https://github.com/shadowsocks/shadowsocks-rust)，节点分享链接遵循 [SIP002](https://shadowsocks.org/doc/sip002.html)。本机运行 SS 时需安装客户端并设置 `SSLOCAL_EXECUTABLE`。API 密钥、SS 密码和通知地址在数据库中加密保存，接口不回显密钥和密码。


## 确定目标站点后接入

默认配置不预设商城系统。使用 `examples/config.template.json` 填写从实际页面学到的证据，选择 `adapter: "learned"`。明确为 WHMCS 时，可使用 `examples/whmcs.config.template.json`。

空选择器、空订单标识模式和空实测样本需要补齐才能运行。站点未知时可以启动工作台，但不能发布或真实下单。

`site.monitorUrl` 是只读商品入口，`site.orderUrl` 是下单动作入口。推广链接放在 `warmupUrls`。WHMCS 的 `cart.php?gid=...` 等地址只属于该站点的配置。

`site.reads` 按路径、固定查询参数和允许的动态参数声明只读请求；多余查询参数不会自动放行。`site.writes` 记录实际写动作的 operation、method、path、query。验证码请求通过 `browserRequests` 单独声明，Cloudflare 动态挑战路径限定为 `/cdn-cgi/challenge-platform/`。

## 登录、会话与代理

登录配置示意：

```json
{
  "login": {
    "url": "https://merchant.example/login",
    "usernameEnv": "SITE_USERNAME",
    "passwordEnv": "SITE_PASSWORD",
    "usernameSelector": "从实际页面采集",
    "passwordSelector": "从实际页面采集",
    "submitSelector": "从实际页面采集",
    "request": {"method": "POST", "path": "/session"}
  }
}
```

登录页面需要加入只读请求配置。`authenticated` 提供证明当前账户已登录的页面条件。

CLI `login` 打开浏览器，操作员登录后按 Enter 核验并保存会话。浏览器账户目录在 `DATA_DIR/browser/<account>`。启动时复用会话并预热，之后定时检查登录状态；已配置自动登录时，过期会话会重新登录。

代理配置使用 `proxy: {server, usernameEnv, passwordEnv}`，凭据从环境变量读取。CLI 与常驻服务共用浏览器目录时，先停止服务再执行独立登录。

## 保存账号密码与自动重登

保存站点配置后，在工作台“登录账户”中输入账号密码，点击“保存并登录”。凭据按站点和账户隔离，使用 AES-256-GCM 加密。保存后密码输入框清空，接口只返回账号名和保存状态。

浏览器重启后复用已保存会话。默认每 60 秒检测登录状态，间隔由 `keepAliveMs` 配置。检测到掉线后，使用已保存凭据重新登录；监控页面跳回登录页时，恢复会话后重新完成库存双确认。

可在站点配置中声明明确的掉线与登录失败证据：

```json
{
  "loggedOut": [{"kind": "visible", "selector": "实际登录表单"}],
  "login": {
    "failed": [{"kind": "visible", "selector": "实际账号密码错误提示"}]
  }
}
```

这些字段补充到已学习的登录步骤中。没有保存凭据时，可使用 usernameEnv、passwordEnv 指定的环境变量。

“检测并重新登录”立即检查会话，需要时重登；CLI 使用 `check-login`。“删除已保存账号”删除本地凭据，当前会话仍可使用，过期后需要重新提供凭据。

更换登录账号后，需要用新账号重新完成两次试运行。同一账号修改密码不改变购买参数。恢复会话只重试登录和交易前的只读检查；结果未知的下单与付款不会重发。

凭据密钥优先读取 `CREDENTIALS_KEY` 环境变量，值为 64 位十六进制字符串；未设置时读取数据目录中的 `credentials.key`。文件支持 32 字节二进制和 64 位十六进制文本（可带末尾换行），读取时保留原文件。新数据目录自动生成二进制密钥。

备份数据目录时同时保留 `runtime.sqlite` 和 `credentials.key`；通过环境变量提供密钥时，也需备份该变量。已有加密凭据缺少密钥，或提供的密钥格式错误时，停止启动并保留原数据，恢复原密钥后重启。

## 库存强信号

`stock.page` 确认商品身份，`stock.scope` 将定位限定在该商品区域。

- 表单方式：同一个可见表单中，所有 `stock.fields` 和可点击的 `stock.submit` 必须同时存在。字段可声明精确值。
- 数量方式：`stock.available` 指向唯一库存元素，`stock.availablePattern` 是从实际页面学到的完整匹配模式，第一捕获组是库存数字。例如文本为“剩余 3 件”时，JSON 中的模式是 `"^剩余 (\\d+) 件$"`。
- `stock.soldOut` 提供明确缺货证据。其余情况返回 unknown。

WHMCS 适配器保留 `N Available` 数量格式。价格、周期和 Continue 等普通文字不构成库存证据。监控命中后立即重新打开只读页复查，两次均为 in 才触发。明确库存数量不足购买数量时，执行前停止。

## 报价与订单记录

`quote` 定位商品、数量、含税总额、币种和付款方式。金额字段输出明确的十进制数字，币种独立，例如 `12.50` 与 `CNY`。进入安全内核后采用整数最小货币单位。

`history.complete` 必须证明商家订单列表完整。每条记录提供 reference、product、quantity、currency；可通过 createdAt 提供标准时间。WHMCS 配置的引用字段名为 invoiceId。

如果列表只展示交易标识，可配置 `history.detail` 逐条读取详情：

```json
{
  "link": "订单行中的详情链接选择器",
  "complete": [{"kind": "visible", "selector": "完整订单标记"}],
  "fields": {
    "reference": "订单标识选择器",
    "product": "商品选择器",
    "quantity": "数量选择器",
    "currency": "币种选择器"
  }
}
```

同一个购买意图的 key 不能重复执行。商家存在相同商品、数量和币种的记录也会停止。明确进行下一次购买时使用新 key；`intent.historySince` 可指定此次购买的判重起点，需要商家记录提供可识别时间。

## 订单完成证据

普通站点通过 `confirmation` 定义结果：

```json
{
  "confirmation": {
    "url": {"path": "/checkout/complete"},
    "ready": [{"kind": "visible", "selector": "实际完成页标记"}],
    "id": "实际订单号选择器",
    "idPattern": "^ORDER-[A-Z0-9]+$"
  }
}
```

地址和标识格式从本站点成功操作采集。订单号可包含字母和数字。仅在 URL 中确有对应参数时才配置 idQuery，并核对该参数与页面标识一致。

完成页另有详情链接时，使用 `receipt`：

```json
{
  "receipt": {
    "url": {"path": "/checkout/success"},
    "ready": [{"kind": "visible", "selector": "实际完成标记"}],
    "id": "实际订单号选择器",
    "confirmationLink": "唯一订单详情链接选择器"
  }
}
```

详情链接必须属于本站点的结果地址。结果标识必须通过实测模式校验，并且不能属于提交前已有记录。

WHMCS 使用 `invoice: {url,id,idQuery}` 配置账单页，完成页链接字段为 `receipt.invoiceLink`。这些差异在 WHMCS 适配器中处理。

下单成功同时要求实际发送唯一提交请求和取得新交易凭证。审计记录与安全内核统一保存该凭证，试运行不会伪造下单成功。

## 工作流和超时

每步包含前置检查、动作、后置验证及成功实测耗时：

```json
{
  "id": "submit",
  "action": "submit",
  "target": {"selector": "本站点提交按钮"},
  "request": {"method": "POST", "path": "/order/place"},
  "pre": [{"kind": "visible", "selector": "本站点确认表单"}],
  "post": [{"kind": "visible", "selector": "本站点完成证据"}],
  "timing": {
    "order": {"samplesMs": [19000, 21000], "marginMs": 45000, "idleMs": 40000}
  }
}
```

上例展示最大成功耗时 21 秒加 45 秒余量，得到 66 秒绝对上限。部署时使用对应动作的实际成功样本。失败耗时和试运行的提交定位耗时不能充当真实提交耗时。

`idleMs` 是无网络收包、无内容变化的最长等待，不能超过绝对上限。监控使用独立的 monitor 策略。

动作包括 navigate、fill、select、check、cart、configure、coupon、submit、pay。条件包括 visible、absent、text、value、url、checked。文本使用 equals 或明确 pattern。参数写作 `{{intent.quantity}}`、`{{coupon}}` 等。

`inspect --url URL` 读取已学习的只读页面，输出表单、字段、按钮与选择器，不输出输入值。`anchors --id ID --version N` 进行安全试运行并采集控件图像锚点，保存为新候选。新版本仍需两次试运行。

## 余额付款与优惠码

`goal: "invoice"` 在创建订单或账单后停止。`goal: "pay"` 继续执行已学习的账户余额付款。

内部付款意图 `paymentMethod: "credit"` 表示账户余额。如果商家的实际付款代码是其他值，用 `payment.balanceMethod` 声明，例如 `"wallet"`。页面选中方式必须与该实测代码一致，表单请求仍绑定商家原始字段和值。

`payment.reviewBalance`、`reviewBalanceCurrency` 在提交前核对余额；结果页通过 `balance`、`balanceCurrency` 再次检查。`payment.paid` 核验本次交易已支付。

`payment.probeUrl` 是当前账户已有订单或账单的只读学习链接。付款试运行只读取该结果及付款控件，不提交或付款。

`couponPolicy` 默认 remove-and-continue，也可选择 stop。`site.coupon.invalid` 提供优惠无效证据；`site.coupon.remove` 声明删码的 target、request、post。无效优惠先核验响应，再单独申请一次删码许可。删码后按实际总额检查预算。

## 提炼、版本与场外 AI

`extract --file extraction.json` 接收 id、source、runs、parameters、orderMarginMs、idleMs。runs 是真实提交成功的完整记录，包含每步 recipe、durationMs、verified。多个样本必须来自相同动作语义。

`diff --id ID --a N --b N` 给出字段差异。`rollback` 只选择仍有效的已验证版本。实际执行绑定当前发布版本和已验证参数。

AI 配置为独立命令：`{command,args,timeoutMs}`。命令从 stdin 读取 `{task,input,contract}`，向 stdout 输出 JSON。生成和修补返回 `{workflow}`，诊断返回 `{category,report,fix}`。输出只进入待验证区。

内置客户端使用环境变量：

```dotenv
AI_ENDPOINT=https://api.deepseek.com/chat/completions
AI_MODEL=填写服务支持的模型
AI_API_KEY=填写密钥
```

客户端采用 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) 和 [JSON 输出](https://api-docs.deepseek.com/guides/json_mode/) 协议，也可使用其他符合进程输入输出约定的场外工具。

```bash
npm run cli -- generate --file evidence.json
npm run cli -- diagnose --run RUN_ID
npm run cli -- repair --run RUN_ID
```

生成器依据实际页面证据，不预设站点系统。诊断只发送分类错误、步骤摘要和不含字段值的页面结构。截图留在本机。修补创建新候选，不直接改动发布版本或安全内核。

## 未知交易的人工处理

核对商家订单记录后登记明确结果：

```bash
npm run cli -- resolve --key purchase-001 --outcome not-created --note "已核对商家记录，没有创建订单"
npm run cli -- resolve --key purchase-001 --outcome created --invoice ORDER-A1 --note "已核对订单 ORDER-A1"
```

已确认或已付款交易不能声明为未创建。结果和核对说明进入操作记录。

## 购后体检与接口

`healthcheck --file examples/healthcheck.json` 使用 SSH 密钥执行 CPU、128 MiB 临时写入、网络接口和路由检查，每项保留退出码、耗时与输出。

| 方法与路径 | 操作 |
| --- | --- |
| GET /api/health | 服务存活 |
| GET /api/connections | 已保存 API 和出口的公开信息 |
| POST /api/apis/save、/test、/default、/delete | 添加、测试、设置默认或删除 API |
| POST /api/proxies/save、/test、/delete | 添加、测试或删除 SS / HTTP 出口 |
| GET /api/monitors | 监控任务和检查结果 |
| POST /api/monitors/analyze | 根据自然语言与真实页面生成并验证监控 |
| POST /api/monitors/start、/stop、/check、/delete | 启动、暂停、立即检查或删除任务 |
| GET /api/status | 版本、运行、指标、修补队列和事件 |
| GET、POST /api/config | 读取、保存本站点配置 |
| POST /api/workflows | 导入新候选 |
| GET /api/workflow?id=...&version=... | 查看版本 |
| GET /api/diff?id=...&a=...&b=... | 比较版本 |
| POST /api/publish、/api/rollback | 发布、回滚 |
| POST /api/warm | 登录和预热 |
| GET、POST /api/credentials | 读取保存状态、加密保存账号密码 |
| POST /api/credentials/delete | 删除保存的账号密码 |
| POST /api/session/check | 检测登录状态并恢复 |
| POST /api/run | 运行 workflowId、version、mode、goal |
| POST /api/monitor/start、/api/monitor/stop | 启停监控 |
| POST /api/resolve | 人工处理未知交易 |
| POST /api/diagnose、/api/repair | 场外诊断与修补候选 |

## 已知限制

原数据目录中的 `state.json` 会保留。旧版监控、账号和任务配置需按当前站点学习流程重新配置。

工作台默认监听 127.0.0.1，供本机协作者使用。同一账户浏览器同时执行一个任务。实际站点需有可学习的原生操作、登录证据、完整商家记录和可验证的结果标识。
