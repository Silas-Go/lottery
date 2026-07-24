# 秒杀订单状态机与可靠性边界

本文描述当前代码实际实现的可靠性语义。两个库存模式共享同一套订单生命周期，差别仅在库存准入和 `pending_payment` 建立方式。

首页 `/` 的“秒杀实验室”是纯前端预览：倒计时、请求卡、限流、重复与售罄结果均为视觉 Mock，
不会调用 `/lucky`、`/pay`、`/giveup` 或指标接口，也不能用于判断真实库存和订单状态。
真实 Cache-Aside 章节从材料情报店 `/material-shop` 进入，后端可靠性边界仍以本文后续链路为准。

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

材料情报店的“召集人潮”不再依赖用户复制终端命令。浏览器只调用主应用
`/api/loadtests`，主应用再通过 Compose 内部地址访问常驻 `loadtest-runner:8090`：

```text
Browser -> app:5678 -> loadtest-runner:8090 -> wrk2 child process
                                      \-> app:5678/api/archives/:id/{direct|cached}
```

前端职责也按场景拆开：`/material-shop` 只负责选择材料、模式和挡位、创建任务并携带
`taskId` 进入店内；`/lab` 才订阅任务 SSE、轮询恢复状态、显示详细指标和日志、执行停止，
并在完整 Task 到达后冻结本轮结果。这样室外入口保持轻量，刷新或重新入店仍能从 Runner 权威状态恢复。

任务完成后的购买意愿是明确的教学叙事而非后端业务预测：购买页固定承接“1500 人完成调查，
150 人决定购买”的案例；`actualRequests` 只用于 wrk2 压测指标，不会被误当作独立用户数。
购买实验会真实并发释放 150 个唯一请求、扣减共享的 `materials.stock`，同时写入独立的购买实验
订单账本；它不触碰秒杀订单或支付状态机。

可靠性与安全约束：

- Runner 不挂载 `/var/run/docker.sock`，也不执行 `docker compose run`；它只能管理自己的 wrk2 子进程。
- 公开请求只有 `experiment`、`archiveId`、`mode`、`tier`。目标 URL、Lua 路径、线程、连接数、速率和时长均由服务端白名单生成。
- `archiveId` 只允许当前材料夹具 1..4，模式只允许 `direct|cached`，实验只允许 `cache-aside-read`。
- 四个挡位最长 20 秒，Runner 代码仍设置 30 秒配置上限和额外的整体硬超时；异常或超时必须回收进程并释放单任务锁。
- 同一时间最多一个活动任务。互斥锁在 Runner 内而非浏览器内，所以多标签页同时点击也只有一个任务成功。
- 创建请求的 HTTP 生命周期不拥有任务 context；页面关闭只断开 SSE，不能停止任务。停止必须显式调用 `/api/loadtests/:id/stop`。
- 任务快照和有限事件历史写入 `loadtest-runner-data`。Runner 重启后发现 `starting/resetting/running/collecting` 遗留状态会标记为 `failed`，不会永久占锁。
- SSE 使用事件 ID 回放，浏览器断线后同时通过状态查询恢复。日志只记录重置、启动、目标速率、异常、结束和解析，不逐请求输出。
- 最终对比表只使用 wrk2 汇总与完整直方图中的 Requests、Actual QPS、实际时长、P50/P90/P95/P99、Timeouts 和 Error Rate；服务端 SQL、连接池、缓存命中率与实时 P99 只留在 SSE 观测区，不再混入最终胜负口径。
- wrk2 对极低延迟多线程直方图存在上游断言缺陷，因此只读实验固定一个 wrk2 线程；连接数仍按挡位提升到 96，本机可以维持 3000 req/s 目标附近的压力。

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
-> Consumer 创建 MySQL pending_payment 账本
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
- 异步落单：Consumer 幂等创建 MySQL `pending_payment`，随后推进 Redis 状态。
- 支付：Redis Lua 先裁决 `pending_payment -> paid`，再推进 MySQL 最终账本。
- 取消：Redis Lua 裁决非终态 `-> cancelled` 并只增加一次库存，再写 MySQL 最终账本。
- Redis 中保留 `paid/cancelled` 到 TTL，迟到的支付或取消可以识别终态，不能依赖“Key 不存在”猜测结果。
- admission TTL 长于支付窗口；TTL 只清理残留，不能承担库存回补。

## MQ 消费语义

Consumer 同时订阅：

- `CREATE_ORDER`：普通异步落单。
- `CANCEL_ORDER`：延迟超时检查。
- `PURCHASE_CACHE_INVALIDATE`：购买实验材料 DTO 缓存失效。

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

### Consumer 落库成功但 Ack 失败

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

重置时先在 MySQL 事务中锁定材料行、恢复购买实验固定库存 300、取消未完成 Outbox，并删除该材料的实验订单；
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
-> claim pending/retry event
-> publish PURCHASE_CACHE_INVALIDATE
-> mark published

Consumer
-> validate event_id + material_id
-> idempotent DEL archive:material-detail:v2:{materialId}
-> mark completed
```

订单、库存和 Outbox 在同一事务中提交；Outbox 唯一键失败会回滚整笔购买。Worker 使用
`pending -> publishing -> published`，发布失败进入 `retry` 并指数退避；进程重启会把遗留
`publishing` 恢复为 `retry`。消息可能在数据库写回前已经被 Consumer 处理，因此 Consumer 的
`completed` 是终态，发布者不能把它倒退为 `published`。

Redis 删除失败时 Consumer 不 Ack，并记录 `retry_count/last_error`；RocketMQ 重投后再次 DEL。
DEL 天然幂等，`completed` 事件收到重复消息时直接成功返回。

主页面固定提交 150 个唯一购买请求，每人购买 1 件；服务端白名单上限同样是 150，不接受 URL、
脚本、Topic 或任意命令。请求由服务端同时释放，但每一笔仍复用原有条件扣库存、订单幂等和
同步 DEL / 事务内 Outbox 语义。页面另以固定 20 QPS 调用真实 Cached 查询接口作为后台库存探针，
在响应后读取 MySQL 权威库存判断旧读并记录最大观测窗口。前端寓言动作和技术节点只读取真实
trace、HTTP 状态及 Outbox 时间字段，不用定时器伪造业务完成。

购买页把“真实执行”和“过程回放”明确分成两个阶段：前端先等待购买接口、Outbox / Consumer
轮询和最终库存探针全部结束，再把服务端 trace、Outbox 时间证据、探针样本及最终指标冻结为本轮
回放记录。六步时间线的播放、暂停、前进、后退、重新播放和结果跳转只在这份前端记录上移动游标，
不会重新调用 `/api/purchase-lab/:id/run`、重置库存或发送 MQ；只有“重新运行当前方案”和
“使用另一方案运行”会开始新一轮真实执行。当前回放位置及两个方案各自的完整记录保存在
`sessionStorage`，用于刷新前的恢复，不承担服务端账本或跨设备持久化职责。

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
