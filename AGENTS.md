# Agent Guide

给 AI agent 或新维护者使用。先读这里，再读 `readme.md` 和 `docs/reliability.md`。

## 项目定位

Go 秒杀/抽奖系统演示项目。核心链路：

- Go Web 接收抽奖、支付、放弃支付请求
- Redis 承接高并发库存和临时资格，**Redis Lua 保证"防重复、扣库存、写临时资格"的原子性**
- RocketMQ 延时消息负责支付超时后的资格释放
- MySQL 只写最终订单，不参与入口高并发扣库存
- 前端通过 SSE 展示服务端真实指标

默认结构：**Docker 跑依赖（MySQL/Redis/RocketMQ/wrk2），Go app 本机跑**。不要把 Go app 放回 `docker-compose.yml`。

## 快速启动

```powershell
.\scripts\start-infra.ps1          # 启动依赖
.\scripts\run-local-app.ps1         # 启动 Go app → http://localhost:5678/
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128  # 压测
.\scripts\stop-infra.ps1            # 停止依赖
```

验证：`docker compose config --services` 默认不应该出现 `app` 服务。

## 代码分层

```
main.go                 # 极薄入口，只调用 app.New().Run()
internal/app            # 组装日志、DB、Redis、MQ、HTTP server、优雅退出
internal/router         # Gin 路由，只注册不做业务判断
internal/handler        # HTTP 入参/出参、Cookie、状态码，不编排完整业务链路
internal/service        # 抽奖、支付、放弃支付等业务流程
internal/database       # MySQL / Redis 数据访问，含 Redis Lua 脚本
internal/mq             # RocketMQ producer / consumer
internal/metrics        # 秒杀指标、快照、SSE 数据源
internal/util           # 配置、日志、抽奖算法、环境变量
views/                  # 前端页面、CSS、JS
scripts/                # 本地启动、压测和停止脚本
docker/                 # RocketMQ 配置和 wrk2 镜像
docs/                   # 设计和可靠性说明
```

## 核心链路

**抽奖：** `GET /lucky` → handler → service.Draw → Redis 权重选品 → **Redis Lua TryAcquireLotteryAdmission** → MQ SendCancelOrder → 写 cookie 返回 giftID

**支付：** `POST /pay` → handler → service.Pay → **Redis Lua ClaimLotteryAdmission** → MySQL CreateOrder → metrics

**放弃/超时：** `POST /giveup` 或 RocketMQ 延时消息 → **Redis Lua ReleaseLotteryAdmission** → 回补 Redis 库存

**指标：** service/mq/handler 记录 metrics → `GET /api/metrics/snapshot` 快照 + `GET /api/metrics/stream` SSE 推送 → 前端实时展示

## Redis Lua 是核心边界

**关键文件：** `internal/database/admission.go`、`internal/service/lottery.go`、`internal/service/order.go`、`internal/mq/consumer.go`

三个 Lua 脚本共同保证原子性，**绝不能退化为多条普通 Redis 命令**：

| 脚本 | 原子操作 | 返回 |
|------|----------|------|
| TryAcquire | 查重复→查库存→扣库存→写临时资格+TTL | OK / DUPLICATE / SOLD_OUT |
| ClaimLottery | 校验 porder_{uid}==giftID → 删临时资格 | 匹配才删，再写 MySQL |
| ReleaseLottery | 校验 porder_{uid}==giftID → 删临时资格 → 回补库存 | 匹配才回补，防止重复加回 |

**关键约束：**
- Redis Lua 只保证 Redis 内部原子性，不保证 MQ 一定发送成功
- TTL 过期只删 tempOrderKey，**不会自动回补库存**，库存回补依赖 MQ 或补偿任务
- claim 和 release 竞争同一个 tempOrderKey，保证同一份资格只被消费一次

## RocketMQ 注意事项

- 不要移除 `rocket_client.go` 中对 client id / hostname 的兼容逻辑（曾因中文主机名导致 gRPC 报错）
- 本地默认：endpoint `127.0.0.1:8081`，topic `CANCEL_ORDER`，consumer group `lottery`
- MQ 入队成功只表示取消任务已登记，不表示订单最终成功
- MQ 入队失败时，调用方必须立即 release Redis 资格

## Docker 约束

默认 compose 只包含：mysql / redis / rocketmq-namesrv / rocketmq-broker / rocketmq-init，wrk2 仅在 `--profile loadtest` 时启用。

**不要**把 Go app 加回默认 compose，原因：本地开发每次改代码不应 rebuild 镜像；本机跑更适合调试；wrk2 通过 `host.docker.internal:5678` 打本机 Go app。

## 错误处理

- 业务错误定义在 `internal/service/errors.go`，HTTP 状态码映射在 `internal/handler/errors.go`
- 新增错误：service 定义 code → 返回 `*service.AppError` → handler 用 `writeServiceError` 输出统一 JSON（含 `X-Error-Code` 响应头）→ 必要时在 `statusForCode` 补状态码
- 不要返回空 body 让前端猜

## 日志和可观测性

使用 `log/slog`，不要用 `fmt.Println`。关键链路必须同步补齐：**结构化日志 + 业务错误码 + HTTP 状态码 + metrics 指标**。

常用日志字段：method、path、status、code、uid、gid、try、duration_ms、endpoint、topic、error。

各层职责：
- **handler：** 请求失败必须输出 JSON body + 状态码 + `X-Error-Code`；成功记录请求开始/完成/耗时
- **service：** 记录业务状态变化（准入成功/重复/库存不足/支付/放弃/MQ 失败），返回 `*AppError` 时带 uid/gid/try
- **database/mq：** 出错 wrap 原始 error 并带 key/topic/endpoint/uid/gid 上下文；Lua 返回未知状态按系统错误处理
- **metrics：** 新增失败分支考虑 RecordSystemError / RecordStockFailed / RecordRateLimited 等指标

## 注释规范

**核心原则：解释为什么这样设计，不解释语法。面向维护者和面试讲解。**

必须加注释的场景：导出函数/结构体、中间件、事务、Redis/Lua、缓存、MQ、并发、限流/熔断/重试、幂等、状态机、定时补偿。

每条关键注释至少回答部分问题：**为什么这样设计？保证什么/不保证什么？失败后谁兜底？修改这里最容易引入什么事故？**

特别要求：
- **英文命名必须注释中文业务语义**：状态名（如 `AdmissionAcquired`）、抽象词（如 `admission`/`claim`/`release`）、缩写（如 `ttl`/`uid`/`gid`）、Redis key、Lua KEYS/ARGV
- **Redis Lua**：注释写清楚 KEYS、ARGV、返回值、原子性边界和"TTL 过期不会自动回补"等风险
- **MQ**：说明消息业务语义、生产/消费失败处理、是否需要幂等、是否可能重复消费
- **事务**：说明哪些操作绑定在一起，不放在同一事务中会造成什么不一致
- **缓存**：说明模式（旁路/写穿/写回）、key 格式、数据源、击穿/穿透/雪崩处理
- **幂等/状态机**：说明幂等条件，状态流转写清楚合法路径
- **TODO**：必须说明具体问题、风险后果和后续方向，禁止只写"待优化"

禁止写 `// count 加 1` 这类复述代码的低价值注释。

修改关键链路时，如果行为/边界/幂等条件/一致性假设发生变化，必须同步更新 `docs/reliability.md` 和相关注释。

## 配置

本机脚本覆盖的环境变量：`COMPUTERNAME=itcheer`（规避 RocketMQ/gRPC 中文主机名问题）、`LOTTERY_HTTP_ADDR=localhost:5678`、MySQL/Redis/MQ 连接信息、`LOTTERY_RATE_LIMIT_QPS=800`。详见 `scripts/run-local-app.ps1`。

## 修改指南

**推荐流程：** 读 readme.md 和 docs/reliability.md → 找对应层 → 业务流程优先改 service → Redis 原子动作改 admission.go → HTTP 响应只在 handler 处理 → 新增链路补日志+错误码+状态码+metrics → 关键并发边界/MQ 补偿/Redis Lua 补注释 → 跑 `go test ./... -run '^$'` 和 `docker compose config --quiet`

**绝对不要：**
- 把复杂业务逻辑塞回 `main.go`
- 绕过 Redis Lua 准入直接 `DECR` 库存
- 让 MySQL 参与秒杀入口扣库存
- 把前端指标改成假数据模拟
- 把默认 compose 改成启动 Go app 容器
- 在 handler 中直接编排 Redis + MQ + MySQL 的完整链路

## 可靠性边界

**已覆盖：** Redis Lua 原子准入、防重复、库存不足阻断、MQ 失败/放弃/超时回补库存、支付和超时释放互斥、服务端 metrics + SSE

**尚未生产级：** 多实例全局限流、Redis 准入成功但 MQ 发送前崩溃的 outbox 兜底、订单唯一索引和完整状态机、MQ 消费幂等表、Redis/MySQL/MQ 高可用

## Git 注意事项

```powershell
git status --short --branch
git log --oneline --decorate --graph -n 8
```

不要把 `.gocache/`、`log/`、`*.exe` 提交进去。推送失败先 `Test-NetConnection github.com -Port 443`，不要因此重写历史。
