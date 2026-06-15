# Agent Guide

这份文档给后续维护者或 AI agent 使用。进入仓库后，先读这里，再读 `readme.md` 和 `docs/reliability.md`。

## 项目定位

这是一个 Go 秒杀/抽奖系统演示项目。它的目标不是包装成完整生产系统，而是把高并发秒杀链路讲清楚：

- Go Web 接收抽奖、支付、放弃支付请求。
- Redis 承接高并发库存和临时资格。
- Redis Lua 保证“防重复、扣库存、写临时资格”的原子性。
- RocketMQ 延时消息负责支付超时后的资格释放。
- MySQL 只写最终订单，不参与入口高并发扣库存。
- 前端通过 SSE 展示服务端真实指标。
- wrk2 用于固定 QPS 压测。

默认开发结构：

```text
Docker: MySQL / Redis / RocketMQ / wrk2
Host:   Go Web app
```

不要默认把 Go app 放回 `docker-compose.yml`。本项目故意采用“依赖跑 Docker，Go app 本机跑”的结构。

## 快速启动

启动依赖：

```powershell
.\scripts\start-infra.ps1
```

启动 Go app：

```powershell
.\scripts\run-local-app.ps1
```

访问页面：

```text
http://localhost:5678/
```

本机压测：

```powershell
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128
```

停止依赖：

```powershell
.\scripts\stop-infra.ps1
```

常用验证：

```powershell
$env:GOCACHE='D:\lottery\.gocache'; go test ./... -run '^$'
docker compose config --quiet
docker compose config --services
```

`docker compose config --services` 默认不应该出现 `app` 服务。

## 代码分层

后端代码收在 `internal` 下：

```text
main.go                 程序入口，只调用 app.New().Run()
internal/app            组装日志、DB、Redis、MQ、HTTP server、优雅退出
internal/router         Gin 路由、页面和静态资源注册
internal/handler        HTTP 入参/出参、Cookie、状态码和错误响应
internal/service        抽奖、支付、放弃支付等业务流程
internal/database       MySQL / Redis 数据访问，含 Redis Lua 脚本
internal/mq             RocketMQ producer / consumer
internal/metrics        秒杀指标、快照、SSE 数据来源
internal/util           配置、日志、抽奖算法、环境变量工具
views                   前端页面、CSS、JS、图片
scripts                 本地启动、压测和停止脚本
docker                  RocketMQ 配置和 wrk2 镜像
docs                    设计和可靠性说明
```

分层约束：

- `main.go` 保持很薄，不放业务逻辑。
- `internal/router` 只注册路由，不做业务判断。
- `internal/handler` 只做 HTTP 适配，不编排完整业务链路。
- `internal/service` 放业务流程，例如抽奖准入、发送 MQ、支付、放弃。
- `internal/database` 封装 MySQL / Redis 操作，包括 Lua 脚本。
- `internal/mq` 只处理 RocketMQ client、发送、消费和 ack。
- `internal/metrics` 只记录和输出指标，不反向驱动业务。

## 核心链路

抽奖：

```text
GET /lucky
-> internal/router
-> internal/handler.GiftHandler.Lottery
-> internal/service.LotteryService.Draw
-> Redis 读取库存并按库存权重选候选奖品
-> Redis Lua TryAcquireLotteryAdmission
-> RocketMQ SendCancelOrder
-> handler 写 cookie 并返回 giftID
```

支付：

```text
POST /pay
-> OrderHandler.Pay
-> OrderService.Pay
-> Redis Lua ClaimLotteryAdmission
-> MySQL CreateOrder
-> metrics RecordOrderCompleted
```

放弃支付：

```text
POST /giveup
-> OrderHandler.GiveUp
-> OrderService.GiveUp
-> Redis Lua ReleaseLotteryAdmission
-> 回补 Redis 库存
```

超时补偿：

```text
RocketMQ delayed message
-> mq.ReceiveCancelOrder
-> Redis Lua ReleaseLotteryAdmission
-> 回补 Redis 库存
-> Ack message
```

指标：

```text
service / mq / handler 记录 metrics
-> GET /api/metrics/snapshot 返回快照
-> GET /api/metrics/stream 通过 SSE 推送
-> views/js/seckill-lab.js 展示实时指标
```

## Redis Lua 是核心边界

关键文件：

```text
internal/database/admission.go
internal/service/lottery.go
internal/service/order.go
internal/mq/consumer.go
```

不要把 Lua 准入退回成多条普通 Redis 命令。秒杀资格发放必须保持原子：

```text
检查用户是否已有临时订单
检查库存是否充足
扣库存
写临时订单并设置 TTL
返回 OK / DUPLICATE / SOLD_OUT
```

释放资格也必须走 Lua：

```text
检查 porder_{uid} 是否仍等于 giftID
匹配才删除临时订单
匹配才回补库存
```

支付认领也必须走 Lua：

```text
检查 porder_{uid} 是否仍等于 giftID
匹配才删除临时订单
再写 MySQL 正式订单
```

这三个 Lua 动作共同避免：重复参与、误回补库存、支付和超时取消同时处理同一资格。

## RocketMQ 注意事项

关键文件：

```text
internal/mq/rocket_client.go
internal/mq/producer.go
internal/mq/consumer.go
docker-compose.yml
docker/rocketmq/broker.conf
```

RocketMQ Go v5 client 曾遇到中文主机名导致 gRPC header 非 ASCII 报错的问题。不要移除 `rocket_client.go` 中对 client id / hostname 的兼容逻辑。

本地默认配置：

```text
endpoint: 127.0.0.1:8081
topic: CANCEL_ORDER
consumer group: lottery
```

`rocketmq-init` 会创建 delay topic 和 consumer group。`scripts/start-infra.ps1` 会等待它 `exited 0`。

## Docker 和本机运行约束

`docker-compose.yml` 默认只包含：

```text
mysql
redis
rocketmq-namesrv
rocketmq-broker
rocketmq-init
wrk2 仅在 --profile loadtest 时启用
```

不要随手把 Go app 重新加回默认 compose。原因：

- 本地开发不应该每次改 Go 或前端都重新 build 镜像。
- Go app 本机跑更适合调试。
- Docker Hub 网络不稳定时，依赖容器已有镜像即可继续开发。
- wrk2 默认通过 `host.docker.internal:5678` 打本机 Go app。

`Dockerfile` 可以保留给完整镜像验证，但不是默认开发入口。

## 前端和压测

关键文件：

```text
views/html/lottery.html
views/css/lottery.css
views/js/seckill-lab.js
docker/wrk2/*
```

前端包含抽奖转盘和秒杀实验室面板：

- 生成 wrk2 压测命令。
- 订阅 `/api/metrics/stream`。
- 展示真实服务端指标。

不要把压测指标改回浏览器模拟数据。当前设计要求指标来自服务端真实 metrics。

wrk2 默认目标：

```text
http://host.docker.internal:5678/lucky
```

压测脚本：

```powershell
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128
```

## 错误处理约定

业务错误定义在：

```text
internal/service/errors.go
```

HTTP 状态码映射在：

```text
internal/handler/errors.go
```

新增业务错误时：

1. 在 `service` 定义错误 code。
2. service 返回 `*service.AppError`。
3. handler 使用 `writeServiceError` 输出统一 JSON。
4. 需要时在 `statusForCode` 中补状态码。
5. 保持 `X-Error-Code` 响应头，方便前端和排错。

## 日志和可观测性约定

本项目演示的是高并发链路，不能出现“接口空返回、日志没有上下文、前端不知道状态码”的情况。新增或修改任何关键链路时，必须同步补齐：

```text
结构化日志
业务错误码
HTTP 状态码
metrics 指标
```

日志使用 Go 标准库 `log/slog`，不要散落使用 `fmt.Println`。日志要带可定位字段：

```text
method      HTTP 方法
path        请求路径
status      HTTP 状态码
code        业务错误码
uid         用户 ID
gid         奖品 ID
try         重试次数
duration_ms 耗时
endpoint    MQ / 外部服务地址
topic       MQ topic
error       原始错误
```

handler 层要求：

- 请求失败必须通过 `writeServiceError` 或 `writeAPIError` 输出。
- 错误响应必须包含 JSON body、HTTP 状态码和 `X-Error-Code`。
- 不要直接返回空 body 让前端猜。
- 成功路径可以记录请求开始、请求完成、耗时和关键 ID。

service 层要求：

- 记录业务状态变化，例如准入成功、重复参与、库存不足、支付成功、放弃支付、MQ 发送失败。
- 返回 `*service.AppError` 时带上 `uid`、`gid`、`try` 等 attrs，handler 会把这些写进日志。
- 不要在 service 里直接写 HTTP 响应。

database / mq 层要求：

- Redis、MySQL、RocketMQ 出错时要 wrap 原始 error，并带 key、topic、endpoint、uid、gid 等上下文。
- MQ 消费失败、Ack 失败、消息解析失败必须写日志并记录 metrics。
- Redis Lua 返回未知状态时必须作为系统错误处理。

metrics 要求：

- 新增失败分支时考虑是否需要 `RecordSystemError`、`RecordStockFailed`、`RecordRateLimited`、`RecordInventoryRollback` 等指标。
- 前端实验室面板展示的必须是服务端真实指标，不要用浏览器模拟数据替代。

## 注释规范

本项目是秒杀链路演示系统，注释必须服务于两个目标：

1. 帮助维护者理解为什么这样设计；
2. 帮助面试讲解时准确说明并发边界、一致性边界和失败兜底。

注释禁止机械复述代码表面含义。复杂逻辑如果只提交代码，没有解释设计原因、边界条件和失败处理，视为不合格修改。

---

### 一、必须添加注释的场景

以下代码新增或修改时，必须补充注释：

* 所有导出函数；
* 所有导出结构体；
* 中间件；
* 数据库事务；
* Redis 操作，尤其是 Lua 脚本；
* 缓存相关逻辑；
* MQ 生产、消费、重试、死信、延时消息；
* 并发逻辑，包括 goroutine、channel、锁、WaitGroup、context 取消；
* 限流、熔断、重试、降级逻辑；
* 幂等控制；
* 状态机；
* 定时补偿任务；
* 业务规则复杂或容易误改的代码。

普通变量赋值、简单 getter/setter、无业务含义的工具函数，不要强行写长注释。

---

### 二、注释必须回答的问题

关键链路注释至少回答以下问题中的一部分：

* 这段代码在业务链路中承担什么职责？
* 为什么要这样设计？
* 不这样做会发生什么问题？
* 它保证了什么？
* 它不保证什么？
* 失败后由谁兜底？
* 是否需要重试、回滚、补偿或人工排查？
* 有哪些边界情况？
* 修改这里最容易引入什么事故？

优先解释设计意图、并发边界、一致性边界和失败恢复，不要解释语法。

---

### 三、英文命名与业务语义注释规范

本项目允许使用英文变量名、函数名和状态名，但关键英文命名必须在注释中解释中文业务语义，避免维护者只看到英文单词却不知道它在业务链路中的含义。

尤其是以下场景必须补充中文解释：

* 业务状态名，例如 `AdmissionAcquired`、`AdmissionDuplicate`、`AdmissionSoldOut`；
* 抽象业务词，例如 `admission`、`claim`、`release`、`pending`、`rollback`；
* 缩写词，例如 `ttl`、`uid`、`gid`、`mq`；
* Redis key，例如 `stockKey`、`tempOrderKey`；
* Lua 参数，例如 `KEYS[1]`、`ARGV[2]`；
* 跨系统边界参数，例如 MQ 消息体、延时秒数、幂等 key。

要求：

1. 注释中必须给出中文业务含义；
2. 如果英文词和普通字面意思不同，必须解释它在本项目里的具体含义；
3. 缩写第一次出现时必须写全称或中文解释；
4. Redis Lua 的 `KEYS` 和 `ARGV` 必须说明中文含义、示例 key、单位；
5. 不允许只写英文注释或只复述英文变量名。

示例：

```go
// AdmissionAcquired 表示“秒杀准入成功”。
// admission 在本项目里不是普通“录取”，而是“用户获得临时抢购资格”：
// Redis 已经预扣库存，并写入 porder_{uid} 临时资格。
AdmissionAcquired AdmissionStatus = "OK"

// ttlSeconds 表示临时资格有效期，单位秒。
// TTL 是 Time To Live 的缩写；它只控制 tempOrderKey 何时过期，
// 过期本身不会自动回补库存，库存回补仍依赖 MQ 或补偿任务。
ttlSeconds := int(ttl.Seconds())
```

---

### 四、不要写低价值注释

禁止写这种只重复代码含义的注释：

```go
// count 加 1
count++

// 查询用户
user, err := repo.GetUser(id)

// 判断 err 是否为空
if err != nil {
    return err
}
```

这类注释没有维护价值，会制造噪音。

推荐写这种说明设计原因的注释：

```go
// 使用游标分页而不是 offset 分页，避免消息量增大后出现深分页性能问题。
messages, err := repo.ListMessages(...)

// 消息入库与会话摘要更新必须放在同一个事务中，
// 防止服务异常退出时出现“消息存在但会话列表未更新”的状态不一致。
```

---

### 五、函数注释规范

所有导出函数必须使用 Go 标准注释，且注释必须以函数名开头。

函数注释不要只复述参数和返回值，要说明业务意图、边界和调用方约束。

示例：

```go
// CreateConversation 创建家长与老师之间的会话。
// 系统通过唯一索引保证同一组参与者不会创建重复会话。
// 调用方不需要在写入前额外做重复查询，避免并发下先查后写的竞态。
func CreateConversation(...) {
    ...
}
```

如果函数涉及 Redis、MQ、事务、幂等或补偿，必须额外说明失败语义。

示例：

```go
// TryAcquireLotteryAdmission 尝试为用户发放指定奖品的临时抢购资格。
// Redis 这里只承担高并发入口的预扣库存和临时资格控制，不直接创建最终订单。
// Lua 只保证 Redis 内部的防重复、查库存、扣库存、写资格是原子的，
// 不保证 Redis 扣库存成功后 MQ 一定发送成功。
func TryAcquireLotteryAdmission(...) {
    ...
}
```

---

### 六、业务流程注释规范

涉及多步业务流程时，必须先描述流程，再写代码。流程注释用于帮助维护者快速建立全链路模型，不用于逐行解释实现。

示例：

```go
// 消息发送流程：
//
// 1. 校验会话是否存在；
// 2. 写入消息记录；
// 3. 更新会话最后一条消息；
// 4. 更新未读数；
// 5. WebSocket 实时推送；
// 6. 触发离线通知。
//
// 消息写入、会话摘要和未读数更新必须保持事务一致性，
// 否则服务异常退出时可能出现消息已保存但会话列表未更新。
```

秒杀链路建议使用同样方式描述：

```go
// 秒杀准入流程：
//
// 1. 权重抽奖选出候选 giftID；
// 2. Redis Lua 原子判断用户是否重复参与、库存是否充足；
// 3. 准入成功后预扣 Redis 库存并写入临时资格；
// 4. 发送延时取消 MQ；
// 5. 用户支付成功时 claim 资格，不回补库存；
// 6. 用户超时或失败时 release 资格，回补库存。
//
// 注意：Redis Lua 只保证 Redis 内部原子性。
// 如果 Lua 扣库存成功后进程在 MQ 发送前崩溃，仍可能出现库存悬挂，
// 需要 pending ZSET、Redis Stream 或 Outbox 等补偿机制兜底。
```

---

### 七、Redis 注释规范

Redis 操作必须说明它在链路中的职责边界。秒杀场景尤其要说明以下内容：

* 是否用于预扣库存；
* 是否用于防重复参与；
* 是否依赖 Lua 保证原子性；
* 是否存在 TTL；
* TTL 过期是否会触发业务补偿；
* 库存回补是否幂等；
* Redis 状态和数据库状态谁是最终事实源。

Redis Lua 脚本必须写清楚 KEYS、ARGV、返回值和原子性边界。

示例：

```go
// acquireAdmissionScript 是抽奖准入的 Redis 原子边界。
//
// KEYS:
//   KEYS[1] stockKey      奖品库存 key，例如 lottery:inventory:{giftID}
//   KEYS[2] tempOrderKey  用户临时资格 key，例如 lottery:porder:{uid}
//
// ARGV:
//   ARGV[1] giftID        当前候选奖品 ID，会写入 tempOrderKey 作为资格归属
//   ARGV[2] ttlSeconds    临时资格 TTL，单位秒；ttlSeconds <= 0 时写入不带过期时间
//
// 返回值:
//   "OK"        准入成功：已扣减库存，并写入用户临时资格
//   "DUPLICATE" 用户已有临时资格，拒绝重复参与
//   "SOLD_OUT"  当前奖品库存不足
//
// 原子性:
//   防重复、查库存、扣库存、写临时资格必须在同一个 Lua 脚本中完成，
//   避免高并发下检查库存和扣库存之间被其他请求插队，导致超卖或重复资格。
//
// 注意:
//   TTL 过期只会删除 tempOrderKey，不会自动回补 stockKey。
//   因此 Lua 准入成功后，仍需要 MQ、pending ZSET、Redis Stream 或 Outbox 等机制兜底库存悬挂。
```

Lua 脚本内部不要逐行写教学式注释。优先在脚本上方说明契约和风险。只有反直觉或高风险的行才允许写行内注释。

---

### 八、MQ 注释规范

MQ 相关逻辑必须说明消息的业务语义、可靠性假设和失败处理。

必须说明：

* 这条消息代表什么业务事件；
* 生产失败怎么办；
* 消费失败是否重试；
* 是否需要幂等；
* 是否可能重复消费；
* 是否有死信或补偿任务；
* 消息成功不等于业务成功时，必须明确写出。

示例：

```go
// 准入成功后必须发送延时取消消息。
// 如果用户在支付窗口内没有完成支付，消费者会释放 Redis 临时资格并回补库存。
//
// 注意：MQ 入队成功只表示取消任务已登记，不表示订单最终成功。
// 如果 MQ 入队失败，调用方必须立即 release Redis 资格，避免用户长期占用库存。
err := mq.SendCancelOrder(order, delay)
```

---

### 九、事务注释规范

数据库事务必须说明哪些操作被绑定在一起，以及不放在同一事务中会造成什么状态不一致。

示例：

```go
// 事务保证以下操作同时成功或同时失败：
//
// 1. 创建消息；
// 2. 更新会话摘要；
// 3. 更新未读计数。
//
// 如果拆成多次独立写入，服务在中途异常退出时，
// 可能出现消息已入库但会话列表仍显示旧消息的问题。
```

事务注释必须明确事务边界。不要只写“开启事务”。

---

### 十、缓存注释规范

缓存相关逻辑必须说明采用的模式，例如旁路缓存、写穿、写回、预热。

必须说明：

* 缓存 key 格式；
* 数据源以谁为准；
* 更新时是删除缓存还是更新缓存；
* 如何处理缓存击穿、穿透、雪崩；
* 如何避免并发脏数据。

示例：

```go
// 采用旁路缓存模式：
//
// 1. 先更新数据库；
// 2. 再删除缓存。
//
// 不直接更新缓存，避免并发写入时后完成的旧请求覆盖新数据。
```

---

### 十一、幂等和状态机注释规范

只要代码涉及重复请求、重复消费、超时补偿、支付确认、库存释放，就必须说明幂等条件。

示例：

```go
// release 只允许仍持有临时资格的用户回补库存。
// 如果资格已经被支付 claim 或其他补偿路径 release，脚本返回 false，避免库存重复加回。
released, err := ReleaseLotteryAdmission(uid, giftID)
```

涉及状态迁移时，必须写清楚合法状态流转。

示例：

```go
// 临时资格状态流转：
//
// 无资格
//   -> acquire 成功：扣库存，写临时资格
// 临时资格中
//   -> claim 成功：删除资格，不回补库存
//   -> release 成功：删除资格，回补库存
//
// claim 和 release 竞争同一个 tempOrderKey，保证同一份资格只能被消费一次。
```

---

### 十二、TODO 注释规范

TODO 必须说明具体问题、风险后果和后续方向，禁止只写“待优化”。

不推荐：

```go
// TODO: 优化
```

推荐：

```go
// TODO: 当前准入成功后才发送 MQ，如果进程在 Redis 扣库存成功后、MQ 发送前崩溃，
// 会出现库存悬挂。后续需要引入 pending ZSET、Redis Stream 或 Outbox 兜底补偿。
```

如果 TODO 涉及线上风险，必须说明风险后果。

---

### 十三、日志和指标附近的注释

日志和指标不是注释。只有当日志或指标的业务含义不明显时，才需要补充注释。

推荐：

```go
// 这里只记录 Redis 预扣成功，不代表最终订单成功。
metrics.RecordRedisPreDeduct(giftID)
```

不推荐：

```go
// 打印日志
slog.Info("lottery success")
```

---

### 十四、文档同步要求

修改关键链路时，如果行为、边界、失败兜底、幂等条件或一致性假设发生变化，必须同步更新相关文档。

至少包括：

* `docs/reliability.md`
* Redis Lua 脚本上方注释
* MQ 生产/消费逻辑注释
* 关键函数注释
* 必要时补充测试说明

特别是以下变更，必须更新文档：

* 库存扣减方式变化；
* 临时资格 key 结构变化；
* TTL 策略变化；
* MQ 延时取消逻辑变化；
* release / claim 幂等逻辑变化；
* 新增 pending ZSET、Redis Stream、Outbox 或定时补偿任务；
* 订单最终一致性策略变化。

---

### 十五、Agent 完成任务前必须自检

提交前必须检查：

* 是否补充导出函数注释；
* 是否补充关键业务流程注释；
* 是否补充 Redis / Lua 契约注释；
* 是否补充 MQ 可靠性说明；
* 是否补充事务一致性说明；
* 是否补充缓存模式说明；
* 是否补充幂等和状态流转说明；
* 是否补充异常处理和补偿说明；
* 是否说明当前实现保证什么、不保证什么；
* 修改关键链路时是否同步更新 `docs/reliability.md`。

---

### 十六、总体风格

注释要面向后来维护者和面试讲解。

优秀注释回答：

* 为什么这么写；
* 解决什么问题；
* 不这样做会怎样；
* 这里的边界是什么；
* 失败后谁兜底；
* 哪些地方不能乱改。

不要为了显得专业而堆术语。能保证什么就写什么，不能保证什么也要写清楚。工程代码最忌讳把“部分可靠”写成“完全可靠”。


## 配置和环境变量

主要配置来源：

```text
conf/mysql.yaml
conf/redis.yaml
scripts/run-local-app.ps1
internal/util/env.go
```

本机脚本会覆盖：

```text
COMPUTERNAME=itcheer
LOTTERY_HTTP_ADDR=localhost:5678
LOTTERY_MYSQL_HOST=127.0.0.1
LOTTERY_MYSQL_PORT=3306
LOTTERY_MYSQL_USER=tester
LOTTERY_MYSQL_PASSWORD=123456
LOTTERY_MYSQL_DATABASE=lottery
LOTTERY_REDIS_ADDR=127.0.0.1:6379
LOTTERY_REDIS_DB=2
LOTTERY_MQ_ENABLED=true
LOTTERY_MQ_ENDPOINT=127.0.0.1:8081
LOTTERY_MQ_TOPIC=CANCEL_ORDER
LOTTERY_MQ_CONSUMER_GROUP=lottery
LOTTERY_COOKIE_DOMAIN=localhost
LOTTERY_RATE_LIMIT_QPS=800
```

`COMPUTERNAME=itcheer` 用于规避 RocketMQ/gRPC header 中中文主机名问题，不要轻易删除。

## 修改建议

推荐流程：

1. 先读 `readme.md` 和 `docs/reliability.md`。
2. 找对应层：router / handler / service / database / mq / metrics。
3. 业务流程优先改 service。
4. Redis 原子动作优先改 `internal/database/admission.go`。
5. HTTP 响应格式只在 handler 层处理。
6. 新增链路必须补日志、业务错误码、HTTP 状态码和 metrics。
7. 关键并发边界、MQ 补偿、Redis Lua、非直观兼容逻辑必须补注释。
8. 跑 `go test ./... -run '^$'` 和 `docker compose config --quiet`。

不要做的事：

- 不要把复杂业务逻辑塞回 `main.go`。
- 不要把路由注册散落到多个 handler 文件里。
- 不要在 handler 中直接编排 Redis + MQ + MySQL 的完整链路。
- 不要绕过 Redis Lua 准入直接 `DECR` 库存。
- 不要让 MySQL 参与秒杀入口扣库存。
- 不要把前端指标改成假数据模拟。
- 不要把默认 compose 改成启动 Go app 容器。

## 当前可靠性边界

已经覆盖：

- Redis Lua 原子发放资格。
- 防重复参与。
- 库存不足不继续发放资格。
- MQ 失败、用户放弃、支付超时会回补库存。
- 支付和超时释放不会同时处理同一个临时订单。
- 服务端 metrics + SSE 可观测。

尚未生产级覆盖：

- 多实例全局限流。
- Redis 准入成功但 MQ 发送前进程崩溃的 outbox 兜底。
- 订单唯一索引和完整订单状态机。
- MQ 重复投递下的完整消费幂等表。
- Redis / MySQL / MQ 高可用部署。

继续增强建议：

1. 订单唯一索引和订单状态机。
2. Redis 准入成功后的 outbox / 本地消息表。
3. 分布式限流和用户/IP 维度限流。
4. MQ 消费幂等表。
5. Redis、MySQL、RocketMQ 高可用配置。

## Git 注意事项

改动前先看：

```powershell
git status --short --branch
git log --oneline --decorate --graph -n 8
```

确认不要把无关产物提交进去：

```text
.gocache/
log/
*.exe
```

如果 GitHub HTTPS 推送失败，先判断网络：

```powershell
Test-NetConnection github.com -Port 443
```

不要因为推送失败就重写历史或重置本地提交。
