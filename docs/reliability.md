# 秒杀订单状态机与可靠性边界

本文描述当前代码实际实现的可靠性语义。两个库存模式共享同一套订单生命周期，差别仅在库存准入和 `pending_payment` 建立方式。

首页 `/` 的“秒杀实验室”是纯前端预览：倒计时、请求卡、限流、重复与售罄结果均为视觉 Mock，
不会调用 `/lucky`、`/pay`、`/giveup` 或指标接口，也不能用于判断真实库存和订单状态。
真实查询与购买实验都从材料情报店 `/material-shop` 选择：查询进入 `/lab`，购买进入
`/purchase-lab`。两者共享材料语境，但不互相解锁；由于共用库存与缓存，不应并行运行。后端可靠性边界仍以本文后续链路为准。

## 第一章的只读边界：Cache-Aside 不参与库存裁决

首页第一章使用独立材料读模型演示聚合详情读取。基础列表不计入实验；详情由
`materials`、稀有度/来源字典、`material_components`、`trades` 和
`reviews` 共同组成，不复用秒杀 `orders`：

```text
直读：GET /api/archives/:id/direct
     -> MySQL 基础 JOIN
     -> material_components JOIN materials 组成列表
     -> trades：COUNT / AVG / MAX 交易聚合
     -> reviews：AVG / COUNT 评分聚合

缓存读：GET /api/archives/:id/cached
     -> Redis GET archive:material-detail:v2:{id}
     -> HIT 直接返回
     -> MISS 执行相同 4 条 SQL -> 缓存最终 DTO 300s -> 返回
```

材料详情读链路仍与秒杀 `inventory`、`orders` 和 Redis admission 隔离。购买实验只在自己的
`purchase_lab_orders` 账本中写订单，但会条件更新同一份 `materials.stock`，因此购买成功后
Direct 与 Cached 查询都能观察到真实库存变化。

一致性边界：

- MySQL 材料基础、组成、交易和评分表是权威源，Redis 只保存可丢弃的最终 DTO 副本。
- `materials.stock` 是可变权威数据；应用启动补齐目录夹具时显式排除该列，只有购买事务或实验重置会修改它。
- 组成关系只保存材料外键与用量，组成项名称仍来自 `materials`，避免关系表复制基础字段。
- 缓存不可用时降级回源 MySQL，本次响应正确性不依赖 Redis。
- 单进程按 material id 使用双检互斥合并冷缓存回源；多实例缓存击穿仍需要更完整的治理。
- 用户购买状态不进入公共 DTO，避免 key 按 request id 膨胀；实验订单由 `purchase_lab_orders` 独立查询。
- 购买写入会删除对应 DTO key：同步方案在提交后由当前请求重试 DEL，异步方案由 Outbox + RocketMQ 可靠失效。
- 除购买库存外，当前材料详情没有编辑 API。未来价格、组成、交易聚合或评分发生写入时，也必须复用相同失效边界。
- TTL 只限制旧副本存活时间，不能替代写后失效。
- `/api/chapters/cache-aside/reset` 只清空本章缓存和指标，不触碰订单、库存或 MQ。

## 本地压测 Runner 边界

材料情报店的“查询潮汐”不再依赖用户复制终端命令。浏览器只调用主应用
`/api/loadtests`，主应用再通过 Compose 内部地址访问常驻 `loadtest-runner:8090`：

```text
Browser -> app:5678 -> loadtest-runner:8090 -> wrk2 child process
                                      \-> app:5678/api/archives/:id/{direct|cached}
```

前端职责也按场景拆开：`/material-shop` 当前只开放 `ARC-004 · 星髓`，直接提供查询与购买两个
平级配置入口，不再经过单次查询或第二层方式选择。查询分支负责读取路径、查询潮汐、通路模式和固定时长的计划展示；该页面只保存查询
计划并转场，不调用任务创建接口，也不重置购买实验库存。
`/lab` 在页面可见且收到全局指标 SSE 首帧后创建任务，再订阅任务 SSE、轮询恢复状态、显示详细指标和日志、执行停止，
并在完整 Task 到达后冻结本轮结果。购买分支在店外只选择后端真实支持的缓存失效方案，并把固定的
150 个唯一请求、12 个服务端并发槽、100 初始库存和 20 QPS 浏览器观察探针标成执行契约；
确认后以白名单 `strategy` 进入现有 `/purchase-lab`，仍由用户在店内明确点击才调用购买接口。
查询结果的购买快捷入口也先返回这一步，不读取查询 QPS、连接数或结果作为购买启动条件。其他材料数据和接口仍保留，
以兼容旧任务和未来扩展，但不再出现在当前货物选择流程中。这样室外入口保持轻量，刷新或重新入店仍能从各自权威状态恢复。

场景中的少量法师或“法师公会”只代表请求来源，不与任何数值一一对应。查询潮汐是目标 QPS，
查询卷轴是 HTTP 请求，魔法通路是 wrk2 的 HTTP 持久连接；一条通路可以连续复用，但在当前
HTTP/1.1 链路中通常要等上一请求返回后才能继续。QPS、连接数和 `actualRequests` 都不是在线人数。
购买实验会另行真实并发释放 150 个唯一请求、扣减共享的 `materials.stock`，同时写入独立的
购买实验订单账本；这 150 个请求不由查询 QPS 或查询完成量换算，也不触碰秒杀订单或支付状态机。

可靠性与安全约束：

- Runner 不挂载 `/var/run/docker.sock`，也不执行 `docker compose run`；它只能管理自己的 wrk2 子进程。
- 新页面公开请求只有 `experiment`、`archiveId`、`mode`、`rate`、`connectionMode`，手动模式才额外提交 `connections`；旧 `tier` 只为滚动升级兼容保留。目标 URL、Lua 路径、线程和时长均由服务端生成。`POST /api/loadtests/connection-plan` 只读调用 Runner 的同一套连接估算器，不创建任务；`POST /api/loadtests` 在创建响应中返回最终锁定的 `connections` 和选择原因。
- `archiveId` 只允许当前材料夹具 1..4，模式只允许 `direct|cached`，实验只允许 `cache-aside-read`。
- `rate` 只允许 100 / 300 / 800 / 1500 QPS，`connectionMode` 只允许 `auto|manual`；手动通路数只允许 70 / 140 / 300 / 500，新协议任务固定 30 秒。30 秒为 wrk2 单线程、最多 500 条通路留出校准后的有效延迟采样窗口；旧 tier 任务仍保留原 20 秒兼容值。Runner 另有 30 秒配置上限和额外的整体硬超时；异常或超时必须回收进程并释放单任务锁。
- 自动通路模式依据同一材料历史 uncorrected 请求 P95 估算在途请求数并增加 25% 周转余量，再选择能覆盖估算值的最小白名单档位；没有历史时使用保守基线，估算超过白名单时使用 500 条上限。同一材料、同一目标 QPS 已有自动任务时沿用它的 `wrk2 -c` 配置，保证 Direct 与 Cache-Aside 公平比较。启动前的预估只是当前历史快照，任务创建时会在 Runner 锁内再次计算并锁定最终值。
- 同一时间最多一个活动任务。互斥锁在 Runner 内而非浏览器内，所以多标签页同时点击也只有一个任务成功。
- 店外到店内的 CSS 转场不驱动 Runner。店外把待运行计划写入 sessionStorage 和 URL；店内至少获得一次可见绘制机会并收到 `/api/metrics/stream` 的首个快照后，才提交 `POST /api/loadtests`。不支持 EventSource 时，以成功快照和已启用的持续轮询作为观测就绪条件。
- 创建请求的 HTTP 生命周期不拥有任务 context；页面关闭只断开 SSE，不能停止任务。停止必须显式调用 `/api/loadtests/:id/stop`。
- 任务快照和有限事件历史写入 `loadtest-runner-data`。Runner 重启后发现 `starting/resetting/running/collecting` 遗留状态会标记为 `failed`，不会永久占锁。
- SSE 使用事件 ID 回放，浏览器断线后同时通过状态查询恢复。任务创建响应到店内任务 SSE 建立之间的事件同样由该历史回放覆盖；前端对 GET、轮询和 SSE 做单调合并，旧快照或首次历史回放不能把 `running/completed` 倒退到早期状态。日志只记录重置、启动、目标速率、异常、结束和解析，不逐请求输出。
- 最终对比表只使用 wrk2 汇总与两组完整直方图：Requests、目标/实际 QPS、目标完成率、实际时长、`wrk2 -c` 配置、uncorrected 实际请求 P50/P90/P95/P99、corrected 需求侧 P50/P90/P95/P99、Socket Errors 和 Error Rate；服务端 SQL、连接池、缓存命中率与实时应用 P99 只留在 SSE 观测区，不再混入最终胜负口径。`-c` 是计划保持的连接数，不是独立测得的成功 TCP Socket 数；建连异常必须结合 Socket Errors 判断。
- uncorrected latency 从请求真正写入连接开始计时，到收到响应为止；coordinated-omission corrected latency 从计划投递时刻计时，额外包含连接不足或响应过慢导致请求未按时发出的容量欠账。corrected 值不得标成“客户真实等待时间”，入口积压动画也只能发生在通路入口，不能暗示请求已经进入 MySQL 后等待。
- wrk2 对极低延迟多线程直方图存在上游断言缺陷，因此只读实验固定一个 wrk2 线程；这不代表只有一个用户或一条连接，实际并发由本轮 70 / 140 / 300 / 500 条 HTTP 持久通路承担。

任务正常状态机：

```text
starting -> resetting -> running -> collecting -> completed
                   \-> stopped
任意活动状态 -------> failed
```

`failed`、`stopped`、`completed` 都是终态。进程退出、指标解析失败或内部请求失败后，
Runner 必须先冻结错误原因、清空活动任务 ID，再关闭等待通道，保证下一轮可以安全启动。

## 统一状态机

```text
库存获取成功
    -> stock_acquired
    -> pending_payment
    -> paid
     \-> cancelled
```

合法迁移：

```text
stock_acquired  -> pending_payment
stock_acquired  -> cancelled
pending_payment -> paid
pending_payment -> cancelled
```

`paid` 和 `cancelled` 是互斥终态。重复请求只做幂等读取，不构成新迁移；迟到消息不能把终态恢复成 `pending_payment`。

库存状态与订单状态必须满足：

| 订单状态 | 库存语义 |
|---|---|
| `stock_acquired` | `HELD`，已经占用 |
| `pending_payment` | `HELD`，等待支付 |
| `paid` | `CONSUMED`，永久消耗 |
| `cancelled` | `RELEASED`，只回补一次 |

如果业务将来允许支付后取消，需要新增退款状态，不能复用 `cancelled`。

## 限量材料目录与实验隔离

秒杀/抽取链路的 `inventory` 只保留四种炼金材料：月盐、雾银、龙息琥珀、星髓。它们的名称、
价格和图片与材料世界观一致，但 `inventory.count/cache_stock` 是独立的高并发实验库存，不能与
购买实验的 `materials.stock` 混用。`GET /api/seckill/materials` 只返回目录信息，不承诺实时库存；
真正库存仍由下述 Redis Lua 或 MySQL 事务裁决。

老数据卷不会重跑 `init.sql`。启动时若检测到篮球、茶叶等旧目录，会先清理 Redis admission，
再在同一 MySQL 事务中清空旧秒杀订单并替换四种材料目录。该迁移只在目录不一致时执行；正常重启
不能重置库存。旧消息到达时因找不到匹配 admission 被幂等忽略，不能把已删除的商品重新落单。

## 模式 A：MySQL 权威库存同步准入

入口：`GET /lucky/cacheaside`

```text
请求
-> MySQL 条件扣减 cache_stock
-> 同一事务创建 pending_payment 订单
-> 发送 CANCEL_ORDER 延迟检查
-> 支付或取消
```

关键边界：

- 库存条件扣减和待支付订单创建处于同一个显式数据库事务。
- 支付通过 `WHERE status = pending_payment` 条件更新竞争 `paid`。
- 取消通过同一前置状态竞争 `cancelled`，并在同一事务回补 `cache_stock`。
- 支付与取消只有一个操作能更新成功。
- `cancelled` 重试不会再次回补库存。

Redis 的 `gift_cache_all_stock` 在该模式中只是读快照，不参与库存正确性。真正防超卖的是 MySQL 条件更新。

## 模式 B：Redis 准入、MQ 异步落单

入口：`GET /lucky`

```text
请求
-> Redis Lua 原子扣库存并写 stock_acquired
-> CANCEL_ORDER 延迟消息
-> CREATE_ORDER 普通消息
-> 订单 Consumer 创建 MySQL pending_payment 账本
-> 支付或取消
```

`CREATE_ORDER` 是普通消息，承担异步落单和削平 MySQL 写峰值；`CANCEL_ORDER` 是延迟消息，只承担支付超时检查。两种职责不能混淆。

Redis admission value：

```text
porder_{uid} = {giftID}|{state}
```

例如：

```text
porder_10001 = 3|stock_acquired
porder_10001 = 3|pending_payment
porder_10001 = 3|paid
porder_10001 = 3|cancelled
```

关键边界：

- 获取库存：Lua 原子执行防重、检查库存、扣减、写 `stock_acquired`。
- 异步落单：订单 Consumer 幂等创建 MySQL `pending_payment`，随后推进 Redis 状态。
- 支付：Redis Lua 先裁决 `pending_payment -> paid`，再推进 MySQL 最终账本。
- 取消：Redis Lua 裁决非终态 `-> cancelled` 并只增加一次库存，再写 MySQL 最终账本。
- Redis 中保留 `paid/cancelled` 到 TTL，迟到的支付或取消可以识别终态，不能依赖“Key 不存在”猜测结果。
- admission TTL 长于支付窗口；TTL 只清理残留，不能承担库存回补。

## MQ 消费语义

系统启动两个独立的 SimpleConsumer，并使用不同 Consumer Group：

- 订单 Consumer（group `lottery`）：只订阅 `CREATE_ORDER` 普通异步落单和 `CANCEL_ORDER` 延迟超时检查。
- 缓存失效 Consumer（group `lottery-purchase-cache`）：只订阅 `PURCHASE_CACHE_INVALIDATE` 材料 DTO 缓存失效。

Topic 是消息类别，不等于 Consumer，也不等于一条物理队列。两个 Consumer 各自拉取、处理和 Ack；
缓存失效消息不再轮流经过订单 Topic，因此空的订单 Topic 不会拖慢材料缓存失效。同一 Consumer Group
绝不能运行不同订阅集合，启动时会校验两个 Group 和三个 Topic 均未错误重名。

处理原则：

- 消息解析失败不 Ack。
- 数据库、Redis 或状态机处理失败不 Ack，让 RocketMQ 重投。
- 幂等处理成功后才 Ack。
- 重复 `CREATE_ORDER` 返回原订单，不能重复扣库存或覆盖终态。
- 重复 `CANCEL_ORDER` 看到 `cancelled` 时结束，不能重复回补。
- 重复 `PURCHASE_CACHE_INVALIDATE` 只会再次执行幂等 DEL；已完成或已取消事件直接结束。
- `paid` 收到取消消息时是正常空操作。

## 并发裁决

### 同一用户重复创建

- Redis 模式由 `porder_{uid}` 防重。
- MySQL 模式由事务内检查和 `uk_activity_user(activity_id,user_id)` 兜底。
- 唯一索引冲突时，事务整体回滚本次库存扣减。

### 多用户竞争最后一件库存

- Redis 模式由获取库存 Lua 串行裁决。
- MySQL 模式由 `UPDATE ... WHERE cache_stock > 0` 裁决。
- 只有成功者能进入订单状态机。

### 支付与取消并发

MySQL 模式：

```text
WHERE status = pending_payment
```

Redis 模式：

```text
porder state = pending_payment
```

两种模式都只允许一个终态获胜。支付获胜则不回补；取消获胜则回补一次，后续支付拒绝。

### 主动取消与超时取消并发

两者使用同一个取消入口。第一次成功迁移负责回补，第二次读取 `cancelled` 并幂等结束。

### 创建消息迟到

如果订单已经 `cancelled`，迟到的 `CREATE_ORDER` 只能确认终态，不能执行 `cancelled -> pending_payment`。

### 订单 Consumer 落库成功但 Ack 失败

消息会重投。唯一索引和状态条件更新使第二次消费返回已有订单，不重复建立订单。

## 启动恢复

Redis 库存恢复基于：

```text
inventory.count
- Redis 模式 pending_payment 数量
- Redis 模式 paid 数量
- 尚未写入 MySQL 的 stock_acquired 数量
```

`cancelled` 已经回补，不再扣减；MySQL 模式使用独立 `cache_stock`，也不影响 Redis 可用库存。

## 材料购买实验：同步失效与 Outbox + MQ

`/purchase-lab` 的主实验与材料详情查询共享：

- MySQL 权威库存：`materials.stock`
- Redis DTO：`archive:material-detail:v2:{materialId}`
- 实验订单：`purchase_lab_orders`，`request_id` 唯一
- 可靠事件：`purchase_lab_outbox`，`event_id` 和 `request_id` 唯一

购买页可从材料店前厅直接进入，也可作为查询完成后的延续入口；两条路径都只传递材料编号。
购买页会自行读取库存并在真正开始一轮实验时重置基线，不依赖查询任务或查询结果。

重置时先在 MySQL 事务中锁定材料行、恢复该材料的实验基线（星髓 100，普通材料 300）、取消未完成 Outbox，并删除该材料的实验订单；
事务提交后重新组装材料 DTO 并预热同一个 Redis key。迟到的 MQ 消息读取到 `cancelled` 后不会删除
新预热的缓存。

### 同步缓存失效

```text
HTTP request
-> MySQL transaction
   -> UPDATE materials SET stock = stock - 1 WHERE stock >= 1
   -> INSERT purchase_lab_orders(request_id UNIQUE)
-> COMMIT
-> DEL archive:material-detail:v2:{materialId}，当前请求最多重试 3 次
-> response
```

购买延迟覆盖事务和同步 DEL。若 DEL 重试耗尽，订单与库存已经提交，接口返回失败状态；调用方可用
相同 `request_id` 重试，唯一索引保证不再次扣库存，重试请求只负责再次失效缓存。

### Outbox + MQ 异步失效

```text
HTTP request
-> MySQL transaction
   -> 条件扣减 materials.stock
   -> INSERT purchase_lab_orders
   -> INSERT purchase_lab_outbox
-> COMMIT / response

Outbox Worker
-> every 1s scan pending/retry
-> claim pending/retry event
-> publish PURCHASE_CACHE_INVALIDATE
-> mark published

缓存失效 Consumer
-> validate event_id + material_id
-> idempotent DEL archive:material-detail:v2:{materialId}
-> mark completed
-> Ack
```

订单、库存和 Outbox 在同一事务中提交；Outbox 唯一键失败会回滚整笔购买。Worker 以真实 1 秒周期扫描，批次关键路径结束后从一个完整周期重新计时；API 快照暴露 `publisherScanIntervalMs`、`publisherScanCount`、`publisherLastScanAt` 和 `publisherNextScanAt`，前端倒计时不自行推测扫描事实。Worker 使用
`pending -> publishing -> published`，发布失败进入 `retry` 并指数退避；进程重启会把遗留
`publishing` 和尚未确认消费完成的 `published` 恢复为 `retry`。这既覆盖发送后写回前崩溃，也防止切换到
缓存失效专用 Consumer Group 时遗留事件永久悬挂；重复发布由幂等 DEL 兜底。消息可能在发布状态写回前
已经被缓存失效 Consumer 处理，因此 `completed` 是终态，发布者不能把它倒退为 `published`。

Redis 删除失败时缓存失效 Consumer 不 Ack，并记录 `retry_count/last_error`；RocketMQ 重投后再次 DEL。
DEL 天然幂等，`completed` 事件收到重复消息时直接成功返回。缓存失效 Consumer 只从
`PURCHASE_CACHE_INVALIDATE` 拉取消息，每批最多 16 条，随后逐条校验事件、执行 DEL、标记 completed 并 Ack；
单条失败仍不 Ack。两个 Consumer 都使用 5 秒长轮询：消息到达时 Broker 会立即返回，5 秒只是空队列的最长挂起时间；
过短轮询会被 RocketMQ Proxy 拒绝。非空队列错误会退避 1 秒再重试，避免 Broker/网络异常时形成忙循环并刷爆日志。
`Receive` 的 10 秒参数是消息不可见期，不是拉取等待。

`cacheInvalidationLatencyMs` 统计 `created_at -> invalidated_at`，包含 Outbox 等待扫描、发布、MQ 排队、
缓存失效 Consumer 拉取、DEL 和完成状态回写；它是整段可靠失效链路耗时，不是 Redis `DEL` 命令耗时。

订单 Group 沿用 `lottery` 以保留原订单消费位点；缓存失效使用新 Group `lottery-purchase-cache`。
升级时必须先停旧 app 再启动新 app，不能让同一 `lottery` Group 同时运行旧的三 Topic 订阅和新的订单双 Topic 订阅。

主页面固定提交 150 个唯一购买请求，每个请求购买 1 件；服务端白名单上限同样是 150，不接受 URL、
脚本、Topic 或任意命令。请求由服务端同时释放，但每一笔仍复用原有条件扣库存、订单幂等和
同步 DEL / 事务内 Outbox 语义。服务端每完成 5 个请求就保存一次有界批次进度，页面在 `/run`
返回前轮询该快照，展示 Purchase Tasks、Purchase Service 与 MySQL Transaction 的真实推进；
`criticalPathCompleted` 到达后才将 Response 标为完成并展开异步失效阶段。页面另以固定 20 QPS
调用真实 Cached 查询接口作为持续库存探针，在响应后读取 MySQL 权威库存判断旧读并记录最大观测窗口。
技术节点只读取 run 进度、trace、HTTP 状态、Publisher 扫描时钟及 Outbox 时间字段，不用定时器伪造业务完成。

购买页把“实时执行流”和“保存 trace 回放”明确分开。完整请求路径与异步失效支线始终可见；尚未进入的支线只降亮度，
不再折叠或突然展开。实时阶段只高亮当前节点，并让 20 QPS 探针持续更新 Redis 值、MySQL 值、旧值标记和最大观测窗口。
“当前步骤讲解”固定分为发生了什么、为什么这样做、真实证据和接下来四块：前三块教学文字只随业务语义阶段切换，
高频计数只更新不参与屏幕朗读的证据块，避免真实执行速度反复打断阅读。

全部结束后，前端把 trace、Outbox 时间证据、Publisher 扫描时钟、探针样本及最终指标冻结为本轮回放记录，
默认停在六步时间线的第一步，由用户选择下一步或播放；同步与异步方案共用嵌入执行流顶部的回放控制条，
浏览长流程时控制条保持可见。自动回放在 1x 下每步停留 6 秒。
播放、暂停、前进、后退、重新播放和结果跳转只在这份前端记录上移动游标，不会重新调用
`/api/purchase-lab/:id/run`、重置库存或发送 MQ；只有“重新运行当前方案”和“使用另一方案运行”会开始
新一轮真实执行。当前回放位置及两个方案各自的完整记录保存在 `sessionStorage`，用于刷新前的恢复，
不承担服务端账本或跨设备持久化职责。

旧的错误顺序竞态夹具已经完全移除。当前购买页只运行以上两条真实写链路，不再维护第二份材料库存
或专用 Redis 库存 Key。

## 当前仍然存在的分布式边界

本项目已经具备状态机和幂等消费，但不是完整生产级交易系统。仍需明确：

1. Redis 准入成功、发送第一条 MQ 消息前进程崩溃，仍需要可靠事件/outbox或定期扫描兜底。
2. Redis 终态推进成功、MySQL 最终账本更新失败时依赖重试收敛，需增加对账告警。
3. 当前支付是演示接口，没有接入外部支付平台；真实扣款回调还需要支付流水和退款状态。
4. 本地限流是单进程令牌桶，多实例部署需要全局入口保护。
5. 还需要监控普通落单积压、最长 `stock_acquired` 时长、Redis/MySQL 状态差异和死信数量。

当前定位是：

> 用同一订单生命周期，演示 MySQL 同步交易路径与 Redis 准入、MQ 异步落单路径在吞吐、一致性和故障复杂度上的差异。
