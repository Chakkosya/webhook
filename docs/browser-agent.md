# 通用浏览器下单 Agent

自动下单使用业务 SOP v2：固定业务模板 → 当前页面语义适配 → 程序执行与核验 → 必要时局部重新绑定 → 确认歧义。业务计划没有网站 DOM、CSS/XPath 或执行代码。分类页和商品列表页都是有效入口；后续页面由浏览器逐页访问，不要求用户先提供购物车、结账或确认页快照。旧 v1 任务保留兼容执行接口，重新探索时迁移到 v2。

## 模块及接入

| 文件 | 职责 |
| --- | --- |
| automation/browser/launcher.js | 复用现有 Chromium、代理、私有会话及请求许可。 |
| automation/browser/dom-parser.js | 获取脱敏 HTML、DOM 树、页面文本、表单、选项、可交互元素及可访问性语义；contextText 提供元素所属商品卡片/行的文字上下文。 |
| automation/browser/locator.js | 优先使用当前观察赋予的唯一 DOM 标记，失败再按语义候选解析；歧义时不选第一项。 |
| automation/browser/crawler.js | 探索实际购买流程，在最终提交前结束。 |
| automation/agent/model.js | 不包含定位信息的通用九步 Business SOP，以及配置要求和目标结构校验。 |
| automation/agent/planner.js | 仅在未知流程或页面歧义时调用 AI，一次解释当前页面的配置步骤及最后的导航/核验动作。 |
| automation/agent/flow-template.js | 固定业务阶段、可选分支、核验边界和任务参数来源；不含商城字段名称或选择器。 |
| automation/agent/observation-context.js | 将完整本地观察收敛为当前任务相关的元素、表单关系及去重上下文，明确报告裁剪范围。 |
| automation/agent/local-planner.js | 编译当前页面适配、按已观察到的多个语义线索重新绑定；按模板执行已确认步骤，局部失配才请求辅助。 |
| automation/agent/executor.js | 单步执行、重新观察、购物车核验、配置核验、受控优惠/提交/付款及操作预算。 |
| automation/agent/recovery.js | 同一浏览器内收集页面、截图、错误与历史，限定恢复范围。 |
| automation/agent/memory.js | 按用户、监控和完整 origin 隔离的原子 JSON 经验存储。 |
| automation/adapters/generic-commerce.js | 通用页面类型与新的订单/付款成功证据识别，不含网站专用模板。 |
| automation/logs/evidence.js | 保存脱敏页面 JSON 与输入遮挡截图，提供任务隔离读取及数量上限。 |
| lib/order-contract.js | 从实际原生表单构造请求约束，核对同源 URL、方法、内容类型和全部提交参数；持久化仅保留结构。 |
| lib/order-browser.js | 接入观察、动态定位与成功验证；保留请求许可、金额/币种/数量核验及原订单绑定。 |
| lib/orders.js | 接入业务 SOP、一次探索试跑、审批哈希、动态执行与经验学习。 |
| lib/order-workflow.js | 校验 v2 数据契约，并兼容旧 v1 代码 SOP。 |
| lib/order-execution-log.js | 记录上海时间的 AI 请求/响应摘要、页面观察、定位候选结果、验证及恢复详情、证据 ID、审批、交易起始记录和订单编号。 |
| server.js | 初始化持久化存储并提供探索、profile 和页面证据 API。 |
| public/orders-ui.js | 展示业务 SOP、配置核验及探索结果；沿用用户确认启用节点。 |

部署镜像的 Dockerfile 已包含 automation 目录；.github/workflows/container.yml 新增容器内真实 Chromium、架构及 API 回归。

页面观察包含普通 `div`、`li` 等容器直接承载的核验文字，避免商品名称、数量或总价只有文本却没有可绑定元素。纯布局容器不额外加入候选；原生下拉框提供完整选项，不再只截取前 80 项，以支持地区、系统镜像等较长列表。这些兼容不放宽商品、数量、金额、币种及提交前核验规则，也不保证所有商城均可自动操作；验证码、登录失效和网站风控仍需人工处理。

提交前观察遇到页面跳转引起的执行上下文失效、元素脱离 DOM 时，进入当前障碍最多两次的重新观察恢复流程，不直接重放原动作。原生下拉框操作优先核对实际选项 value，显示文字继续用于业务规格核验。提交结果不明或付款已开始时不因这些错误重试交易。

兼容边界：最终下单要求可对应当前真实表单的同源 POST；支持 URL 编码和字段、值完全等价的扁平 JSON 序列化。无表单或无法对应字段的纯 AJAX、跨域收银台和嵌入式付款仍需专门适配。

## 数据结构

业务计划由用户审阅后参与原审批哈希：

~~~json
{
  "summary": "探索商品购买流程并核对月付套餐",
  "workflow": {
    "version": 2,
    "businessSop": [
      {"id":"open","goal":"打开目标商品页面"},
      {"id":"identify","goal":"识别目标商品"},
      {"id":"purchase","goal":"进入购买流程"},
      {"id":"configure","goal":"配置商品参数和数量"},
      {"id":"coupon","goal":"应用并验证用户优惠信息"},
      {"id":"review","goal":"验证商品、配置、数量、总价和币种"},
      {"id":"checkout","goal":"进入结账流程"},
      {"id":"submit","goal":"经用户授权提交一次订单"},
      {"id":"verify","goal":"验证新订单及付款结果"}
    ],
    "requirements": [{"name":"付费周期","value":"月付"}]
  }
}
~~~

浏览器读取全部匹配的语义节点和表单，后续按钮不再因排在第 600 个节点之后被丢弃。DOM 摘要保留前 1200 个节点及全部语义节点的祖先关系；HTML、正文等大字段仍限制长度。观察与日志中的 `totalElements`、`totalDomNodes`、`truncated` 明确报告覆盖范围。

浏览器观察结构：

~~~json
{
  "observationId": "一次观察的 UUID",
  "url": "https://merchant.example/checkout",
  "title": "结账",
  "html": "脱敏 HTML，最多 64000 字符",
  "text": "可见页面文本，最多 24000 字符",
  "domTree": [{"node":"n0","tag":"main","parent":null,"elementRef":"e0"}],
  "elements": [{
    "ref":"e0","role":"button","accessibleName":"确认订单",
    "text":"确认订单","label":"","visible":true,
    "disabled":false,"options":[]
  }],
  "forms": [{"ref":"e1","method":"post","action":"/checkout","fields":["e0"]}],
  "network": [{"method":"GET","url":"https://merchant.example/checkout","status":200}]
}
~~~

一次动态计划只引用当前观察的元素：

~~~json
{
  "action": "review",
  "reason": "当前页面已提供全部核验字段",
  "bindings": {
    "submit": {"meaning":"submit_order","ref":"e0","confidence":0.95},
    "product": {"meaning":"product","ref":"e2","confidence":0.95},
    "quantity": {"meaning":"quantity","ref":"e3","confidence":0.95},
    "total": {"meaning":"total","ref":"e4","confidence":0.95},
    "currency": {"meaning":"currency","ref":"e5","confidence":0.95}
  },
  "configuration": [
    {"name":"付费周期","target":{"meaning":"billing_cycle","ref":"e6","confidence":0.95}}
  ]
}
~~~

临时 ref 与宿主生成的定位候选只在当前观察有效。每次动作后重新观察；网站记忆不保存 ref、selector、DOM、账号、Cookie 或实际字段值。任务的 program.runtimePlan 保存已经执行并通过核验的页面适配组、业务阶段、观察得到的语义线索及授权参数来源，参与审批哈希；不保存临时 ref、CSS/XPath 或页面 HTML。重新准备和正式执行在当前页面重新匹配唯一元素，按已发现的配置顺序运行，已达到目标值的输入/选项不会重复执行。结构或目标出现歧义则请求 AI 辅助，不能沿用旧 ref。ARIA 等候选必须唯一，并且必须对应同一个已观察节点；全部失败后重新观察，不能点击任意第一个匹配项。

动作包括 fill、select、check、uncheck、click、cart、choosePayment、verify_cart、apply_coupon、review、invoice、pay、stop。优惠请求之后专用 verify_coupon 只重新绑定实际核验元素，不能重复应用。cart 返回后必须核验真实商品和数量；review 核验真实选中配置；优惠应用验证码、实际减免及总价降低，并在页面跳转/ID 变化后重新绑定。最终提交不需要提前知道成功页 DOM。

经验文件保存在 DATA_DIR/automation/profiles/<用户与监控哈希>/<origin哈希>.json，例如：

~~~json
{
  "schemaVersion": 1,
  "origin": "https://merchant.example",
  "platformType": "generic-commerce",
  "pageTypes": ["product_or_other","cart","checkout","order_result","invoice"],
  "elementSemantics": ["add_to_cart","quantity","submit_order","invoice","pay"],
  "successPaths": [{"status":"ordered","steps":[{"pageType":"checkout","action":"review","meanings":["submit_order"],"verified":true}]}],
  "failurePaths": [{"status":"recovery","errorCode":"AGENT_ELEMENT_MISSING","steps":[]}],
  "outcomes": {"prepared":2,"ordered":1}
}
~~~

经验先读取再规划，失败时重新观察并更新。探索由宿主 dryRun 会话保证不提交，同时保留付款意图供提交前核验。探索只记录实际访问并验证的路径，不虚构尚未打开的成功页、账单或付款页。实际成功交易之后补充这些阶段的经验。

截图及页面证据保存在 DATA_DIR/automation/logs/<用户与任务哈希>/<证据UUID>.json/.png，默认每任务保留 40 份。JSON 含实际 URL、HTML/DOM、网络状态与阶段；输入框、textarea、可编辑区域及 data-private 内容在截图中遮挡。恢复时可向支持图像输入的模型发送截图；模型不支持图像时会如实报错，不重复交易。

## HTTP API

所有接口沿用当前登录鉴权及任务所属用户检查。

| 请求 | 用途 |
| --- | --- |
| POST /api/order-tasks | 创建任务。输入 url、instruction（任务目标）、monitorId、quantity、maxTotal、currency 和 executionMode；登录会话仍需提前保存。 |
| POST /api/order-tasks/:id/discover | 探索实际购买流程，并完成一次试跑；body.background=true 返回 HTTP 202，由进度接口查询结果。默认同步返回 ready、enabled=false。 |
| POST /api/order-tasks/:id/generate | 保留旧客户端入口，使用新的业务规划提示词；同样支持 background=true。界面默认后台试跑，每秒查询进度，连接短暂中断时重试查询。 |
| GET /api/order-tasks/:id | 查询试跑状态、progress.stage/pass/step、errorCode 与最终 task；不会重新执行任务。 |
| GET /api/order-tasks/:id/profile | 读取当前网站在该用户/监控下的经验，未有记录时 profile=null。 |
| POST /api/order-tasks/:id/enable | 按当前购买配置启用，可不传 codeHash；已有试跑时可传 {codeHash: task.trial.codeHash} 核对版本。expectedRevision 可核对配置版本；不要求试跑成功。金额、要求、账户或任务变化会撤销授权。 |
| POST /api/order-tasks/:id/run | 执行已授权任务。先由代码和已验证流程执行；未知步骤才调用 AI，原订单提交与付款各最多一次。 |
| POST /api/order-tasks/:id/pause | 取消规划/浏览器执行。 |
| GET /api/order-tasks/:id/evidence/:evidenceId | 读取脱敏页面证据 JSON。 |
| GET /api/order-tasks/:id/evidence/:evidenceId.png | 读取截图；过期或不属于当前用户任务的证据返回 404。 |
| GET /api/monitors/:monitorId/order-execution-logs | 导出最新一轮受控操作日志和证据 ID，不叠加历史轮次，不重新执行任务。 |

浏览器内部接口新增 observe()、resolveSemantic(target)、readSemantic(target)、screenshot()、rebindCoupon(checks)，会话提供 captureEvidence(stage)。resolveSemantic 返回当前 selector candidate、strategy、meaning、confidence；候选仅供受控执行器当次使用。外部 API 不允许调用任意浏览器脚本或裸 DOM 操作。

## 风险与恢复边界

保存登录和购买配置后即可启用监控下单。一次试跑是可选操作，在提交前停止。监控触发后直接执行，在同一浏览器中核对商品、数量、配置、总价、币种、付款意图和实际提交表单，核对通过即按授权范围提交。正常流程不固定截图，也不试点提交按钮。提交和付款前保存核验值与持久化交易起始标记。实际 POST 请求继续绑定表单、数量、优惠码、付款方式及账单号，不能用通用 click 绕过。

同一障碍的恢复默认最多 2 次；已核验动作让页面状态实际改变后，为下一障碍重置计数，失败或空操作不重置。总动作上限 40，每轮动态执行预算默认 600 秒（ORDER_AGENT_TIMEOUT_MS），取消信号传递给模型和浏览器。单次 AI 响应默认等待 120 秒（ORDER_AI_TIMEOUT_MS），默认超时后停止本次辅助，不自动重发可能仍在上游处理的请求；保留已经学到的流程。生成业务 SOP 和一次试跑共用 1500 秒总预算（ORDER_TRIAL_TIMEOUT_MS）；上层取消或预算到期立即停止，迟到规划不会执行。元素缺失或页面结构变化在同一浏览器重新理解。未知页面可返回 steps 数组，将本页输入/选项步骤一次编译；导航、优惠或交易必须是数组最后一步，后续页面仍需重新观察。试跑失败不再反复生成整个 v2 SOP 和重启试跑。AI 辅助仍不能唯一确认时，failure.category=needs_input，task.input 给出具体原因、当前候选与确认问题，界面提示补充商品/规格或手动点选。购物车已点击但结果不明时先核验购物车，不能再添加。认证、挑战、请求被拦截、预算/币种错误不会通过 AI 放宽。提交后仅允许处理已确认的原订单；提交/付款结果不明时保留核对状态，不能重试交易。业务要求改变须保存并重新启用。

订单成功要求实际成功响应后的唯一新订单编号和明确成功提示；付款成功要求新的明确付款提示。失败文字、旧提示、点击完成或 AI 自称成功都不作为成功结果。

这是通用页面理解与规划架构，并不承诺所有商城都能自动完成付款。最终提交支持能够明确核验的同源 URL 编码 POST 表单及等价的扁平 JSON 序列化，付款仍使用同源 URL 编码 POST；无法对应当前表单的自定义 JSON 结账、跨域托管付款、未知语言成功提示、iframe/封闭 Shadow DOM、验证码及二次验证等不能安全核实时会停止或保留待付款。已有原账单绑定规则也仍需识别实际账单链接和编号。扩展请求类型时应增加独立的宿主请求验证，不放宽 AI 权限。

## 测试

~~~sh
node --test test/automation.test.js test/automation-assisted.test.js test/automation-api.test.js
node --test test/automation-browser.test.js
npm test
~~~

automation.test.js 验证业务 SOP 禁止定位/代码、八级定位回退、歧义拒绝、购物车与配置核验、同浏览器恢复、防重复添加、网站记忆原子写入/隔离、证据保留与审批哈希。

automation-api.test.js 验证探索、经验和 JSON/PNG 证据接口的鉴权及用户/任务隔离。

automation-browser.test.js 启动本地模拟商城，生成随机 ID 和不同 DOM 包装，验证入口之外的购物车/结账/成功/账单页，单次提交和付款，网站付款选项在重复观察后的绑定，以及优惠请求跳转后全部 ID 改变仍能重新核验。Windows 可使用已安装 Edge，其他环境设置 MONITOR_BROWSER_EXECUTABLE；没有浏览器时该文件明确跳过。测试只操作 localhost，不创建真实商家订单。

test/order-timeouts.test.js 验证 AI 响应体卡住、单次有限重试、取消等待、总体试跑预算、迟到计划不会执行，以及超时不重新生成整个 SOP。.github/orders-ui-smoke.mjs 使用本地 AI 响应体卡住一次和进度请求丢失一次的场景，验证后台 202 启动后自动恢复查询、一次试跑完成与手动停止。

test/automation-discovery.test.js 验证模型错误索要未来页面快照时进入有界重新探索；真实结算证据缺失、购物车待核验及订单已提交时仍停止。automation-browser.test.js 从两种分类卡片布局进入配置、购物车和结账，两个同名 Order Now 按钮依据卡片语义区分，并模拟业务规划与单步规划分别错误拒绝一次，验证恢复后一次试跑和一次提交。

已有 test/orders.test.js、test/order-workflow.test.js、test/order-execution-log.test.js 继续验证旧任务、账户/监控变化、预算、优惠、代理、重启和交易日志的兼容保护。真实模型效果需要在已登录的商家测试环境用 discover → 审阅 → enable → prepare 模式检验，不把模拟规划器当作真实模型适配证明。

新的 automation-assisted.test.js 检查已适配流程不重复调用 AI、未知页面一次解释多个步骤、一次试跑和一次批准执行复用同一流程、审批哈希保持一致、失败转人工确认而不重新生成 SOP、当前页面绑定失败时才局部请求 AI，以及重复候选不任选第一项。完整控件和选项留在本地观察。AI 输入只发送任务相关的语义摘要，页面 HTML 和 DOM 树不发送；摘要的 coverage、optionsOmitted 和 omittedMatchingControls 明确标注省略范围，不能把截取后的一个候选误当成全页唯一候选。

## 固定模板与动态页面适配

固定的是商品识别、配置、购物车核验、优惠、结算核验、原订单付款等业务目标和核验边界。网站可以省略购物车、把配置与结算放在同一页，或者把配置分成多页。模板不按 Quantity、Cycle、Place order 等词表选择控件。首次遇到未知页面时，AI 根据当前真实页面把业务含义映射到元素，并一次返回本页步骤；后续步骤、一次试跑和正式执行由程序解释这些映射。

runtimePlan 的 version=2 页面适配组按网站路径、查询参数、片段和业务核验状态筛选，避免同一路径的不同步骤互相套用；不要求整页 DOM、标题及无关导航完全相同。名称、标签、可访问性文字、上下文和真实表单关联都是从实际页面学习的备选线索；互相冲突或重复时不选择第一项。导航与购物车入口还须保持已观察到的商品上下文、链接或表单归属。价格类证据在本次页面重新读取；金额变化不通过旧值冒充核验。旧作用域格式不匹配时仅重新学习当前页面；已经完成的本轮动作有独立进度，不因为原按钮仍存在就反复点击。

步骤可声明 valueFrom:"quantity" 或 valueFrom:{requirement:"业务要求名称"}，程序从当前任务取得值。下拉选项使用本次页面的实际 option.value；不把商家的随机选项编码固定成业务要求。配置项、按钮文案、排列顺序、字段 name 或随机 ID 变化时，其他仍唯一的语义线索可完成重新绑定；线索不足时只重新识别当前阶段。

新增回归覆盖任意商家字段文案、字段改名、DOM 重排、额外导航、页面标题与非关键查询变化、当前价格与下拉选项编码变化、任务参数动态赋值，以及同名按钮转移到其他商品时必须重新确认。固定业务阶段不能越过购物车或优惠核验，也不能对已提交订单再次发起商品购买。

## 流程复用与局部辅助

默认配置直接使用业务模板；只有新的自然语言规格需要 AI 整理成 requirements，这一步不发送商家 DOM。任务意图不变时，保存、重新准备和补货唤醒保留 program.runtimePlan，不重新生成同一业务计划。正式执行学到的适配保存在任务内部 flowMemory 和 runtimePlan，供本轮数量调整与后续订单复用；每次从当前观察重新绑定 ref，交易前仍核对原购买要求。目标、数量、规格、预算或执行范围变化会撤销审批。

本轮执行记录已经完成的页面动作，已消失的前序控件不会阻塞后续步骤。付款方式必须由宿主登记，单纯页面已选中不等于已确认付款意图；节点重建后重新登记。已经满足的普通输入、选项和勾选可由宿主只读登记配置证据，不为取得证据反复修改同一个值。

页面辅助摘要按任务文字、真实表单关系和当前已知目标选择内容，重复区域文字通过 contexts 引用。摘要最多 96 个元素、24000 字符，每个选项控件最多 16 个相关选项；这只约束发给 AI 的上下文，本地观察与核对保持完整。引用不在本次摘要中的元素会被拒绝，省略的同名候选会明确报告。

规划、配置或步骤歧义经过局部恢复仍无法确定时，界面列出具体问题、期望值、实际值和候选。用户在当前问题下回答后重新准备，程序从入口复用已学步骤，只为未解决的部分请求辅助；回答不会修改商品、预算或请求许可。关闭自动辅助后，正式执行遇到未知步骤会交给用户，不暗中调用 AI。优惠提交后的恢复仅重新定位与核对，不重复应用优惠。

订单会话关闭 WebSocket 与 Service Worker 旁路。原生最终提交在准备阶段读取有效表单、成功控件及 submitter，生成 requestContract.status=verified，不点击最终提交按钮。正式执行只允许本次表单地址和方法，支持 URL 编码或字段完全等价的扁平 JSON 请求。正式提交还须匹配审批时的结构和当前表单参数。无原生表单、不能对应当前表单的 JSON 请求、多个写请求或无法对应的字段会返回具体未完成原因，不能标记为可执行。配置/购物车不再要求某一组固定的“继续”按钮词或字段名，而根据商品、任务配置证据及完整原生请求判断；证据不足时仍需确认。

下面的效率优化已运行定向测试与本地浏览器用例；验证范围及限制见各节，不代表所有商城均已实测。

## 生成与试跑提速（2026-10-11）

- 预检由两轮减为一轮；已通过旧两轮预检的配置仍兼容。省去第二次浏览器恢复、页面探索和购物车操作，正式触发仍重新核对当前订单。
- 加购后已到结算页时，review 复用商品和数量绑定先完成购物车核验，再提交；无需再向 AI 请求一个单独的 verify_cart 计划。
- 默认数量与规格符合要求时可只读登记，不必重复 fill/select。常规元素读取不重复扫描整页；正常试跑、提交、付款不固定截图。
- AI 首次使用最多 96 个元素、24000 字符的摘要；摘要不足导致停止时，在同一页面最多扩大一次至 288 个元素、64000 字符和每控件 80 个选项。真正缺货或验证码不走此扩展。
- 带价格的选项文案、常见金额小数/分组格式和带订单号的 created/received 成功文案可识别。订单已创建但待付款与已付款分开判断。

定向验证：

~~~bash
node --test test/order-efficiency.test.js test/order-efficiency-browser.test.js test/order-request.test.js test/order-stage-evidence.test.js test/order-evidence.test.js
~~~

浏览器用例只访问本地模拟商城，检查试跑不点击提交、不截图、默认配置复用、GET/POST 配置、等价 JSON 提交、必填字段、超预算和数量篡改。该结果不代表真实商城或真实模型成功率。旧 AI 提示词、页面排序及会话夹具已与当前执行协议同步，完整测试和独立浏览器回归共同验证。

## 流程复用与局部纠错（2026-10-12）

- AI 批量返回的前置填写或选择已经满足要求时，直接登记当前值并继续同批计划；本地浏览器验证默认数量、规格场景只需一次观察，没有重复填写或选择。已学流程继续沿用同样处理。
- 流程复用忽略 utm_*、gclid、dclid、fbclid、msclkid 等统计参数。商品、步骤等业务查询参数及页面片段仍参与匹配；商家文字、上下文和表单关系仍从当前页面绑定。
- 加购后的数量不符时可在当前输入框或下拉框修正，必须绑定当前商品和同一个数量控件，只接受任务数量，之后仍核验商品与数量。不会重新加购；会自动发送后台更新请求的控件仍受原请求许可限制。
- 数量下拉框按选中项的显示数量核验，实际请求使用商家当前 option.value，并继续逐字段核对。例如显示“1 item”、内部值 merchant-units-1 的控件可用于默认配置及最终提交。
- 恢复次数按已核验的页面进展分段，避免前页的小故障耗尽后页机会；同一未解决障碍仍最多两次，整体时间、步骤和交易边界保持有效。
- 付款阶段摘要优先保留可见表单关联的字段信息，避免长页面挤掉账单字段；隐藏字段值不发给 AI。

本轮同步了当前规划器测试中旧的双轮预检、页面下标和截图夹具。验证使用本地模拟 AI 与模拟商城，包括已有请求、配置证据和界面回归；未向真实商城提交订单，无法据此计算真实成功率。执行日志回归另覆盖连续试跑、正式执行、其他监控与重启后的轮次隔离；查看和导出均为最新一轮，北京时间不受运行环境时区影响。

## 目标说明、实际数量与分笔交易

目标的 meaning 是最多 300 字的非空文字说明，可包含中文、空格和商品型号；动作类型、当前 ref、实时元素绑定和宿主交易核验控制执行。页面阶段优先使用当前可见商品区域、购买按钮、核验字段及订单证据，不将 Shopping Cart 标题直接当成购物车。日志保留批量步骤、失败动作及对应元素证据，显示原始失败代码与原因。

数量从目标上限开始，按明确库存、输入框 max、下拉选项或固定购物车数量协商本笔数量；超预算逐个减量，并重新配置和读取实际含税费总价。每次尝试共用本轮执行时限。可选试跑使用相同减量核价方式，停在首笔提交前。数量与预算调整不改变用户原配置，所有本笔参数由宿主传给规划器和请求核验。

任务 purchases 在每笔提交前持久化，付款起点及确认结果保存在同一笔记录。上一笔已确认才进入下一笔；下一笔预算扣除所有已创建订单的实际总价，币种固定为第一笔确认币种。提交并付款模式需付款已确认；余额不足、验证等待或交易结果未知会终止本轮，已有订单保留。重启不重放中断交易。purchaseSummary 汇总目标数量、确认数量、累计费用、剩余数量及原因。

补货触发按任务合并；无空闲位置或账户正忙时保留待执行项。释放执行位置后立即调度，账户忙时定期检查；暂停、删除、监控关闭或任务修订使待执行项失效。

验证见 test/order-budget.test.js 与 test/order-budget-browser.test.js。真实 Chromium 用本地商城覆盖同名商品卡片、配置表单跳转、含税预算、数量折扣、优惠重新核价、限购分笔和各笔原账单付款；未据此宣称真实商城或真实模型的成功率。

WHMCS 商品配置页支持 `frmConfigureProduct` 的 AJAX 请求映射：自动计价 `confproduct + calctotal`、周期切换 `cyclechange`、推荐查询与配置继续分别处理，核对当前购物车条目及完整表单参数。配置辅助响应完成后读取最新页面；最终订单提交仍单独核对商品、数量、币种和含税费总价。配置中的服务器 root 密码字段可保留网站默认值，私密值不进入 AI 输入或日志。未知写请求日志记录请求结构与已识别操作，不记录字段值。
