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

## 注释约定

本项目是秒杀链路演示系统，注释要服务于“讲清楚为什么这样设计”，而不是机械解释代码在做什么。

需要补注释的地方：

- Redis Lua 脚本：说明原子边界、key / argv 含义、返回值语义。
- 秒杀准入、释放、支付认领：说明为什么必须绑定库存和临时订单。
- MQ 延时取消：说明为什么发延时消息，以及失败时如何回滚。
- 支付和超时取消的竞态点：说明为什么 Lua claim / release 可以避免重复处理。
- 指标埋点：说明这个指标用来观察什么问题，例如限流、库存不足、MQ 积压、超卖风险。
- 非直观的兼容逻辑：例如 RocketMQ client id / 中文主机名 / gRPC header 兼容。
- 非显然的配置或脚本：例如为什么 Go app 本机跑、wrk2 为什么打 `host.docker.internal`。

不要写的注释：

- 不要写“给变量赋值”“调用函数”“返回结果”这种重复代码本身的注释。
- 不要写已经过期的实现说明。
- 不要用注释掩盖混乱代码；能通过命名和拆函数讲清楚的，优先改结构。

注释风格：

- 短，但要解释原因。
- 面向后来维护者和面试讲解。
- 修改关键链路时，如果行为、边界或失败兜底变了，要同步更新注释和 `docs/reliability.md`。

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
