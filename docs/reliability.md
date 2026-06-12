# 秒杀链路可靠性说明

这份文档解释项目中每个关键链路靠什么保证可靠，以及为什么要这样设计。它的目标不是把项目包装成完整生产系统，而是把“高并发秒杀系统为什么这样拆链路”讲清楚。

## 总体链路

一次成功的秒杀请求会经过这条路径：

```text
Browser / wrk2
-> Gin /lucky
-> 本地 QPS 限流
-> Redis 读取活动库存并抽奖
-> Redis Lua 原子准入
-> RocketMQ 延时取消消息
-> 用户支付 / 主动放弃 / 超时取消
-> MySQL 最终订单
-> SSE 指标面板
```

其中最核心的可靠性边界是：

```text
Redis Lua 原子准入负责发放秒杀资格
RocketMQ 负责超时补偿
MySQL 只负责最终订单，不参与高并发扣库存
```

## 1. 入口限流

代码位置：

```text
internal/service/limiter.go
internal/service/lottery.go
```

当前限流是 Go 进程内令牌桶限流：

```text
同一个 app 进程内，/lucky 按 N token/s 补充令牌
请求拿到令牌才会继续进入 Redis / MQ 链路
```

它保证的是：

```text
保护当前 Go 进程，不让所有请求都进入 Redis / MQ 链路
```

为什么需要它：

```text
限流不是防超卖核心，但它可以提前挡掉明显过载流量，降低 Redis、RocketMQ 和应用线程压力。
```

当前边界：

```text
它是单机内存限流，不是分布式限流。
多 app 实例部署时，每个实例都会各自限流。
桶容量默认等于 QPS，允许短时小突发，但持续流量会被压回配置速率。
```

生产中通常还会在网关层增加全局限流、IP 限流、用户限流和黑名单策略。

## 2. Redis 作为秒杀主库存

代码位置：

```text
internal/database/inventory.go
internal/service/lottery.go
```

MySQL 中的 `inventory.count` 是活动初始化库存，启动时同步到 Redis：

```text
inventory.count -> gift_count_{giftID}
```

请求进入后，服务读取 Redis 当前库存，用库存权重抽出一个候选奖品。

为什么不是直接扣 MySQL：

```text
秒杀瞬时流量很高，MySQL 行锁和事务吞吐更容易成为瓶颈。
Redis 更适合承接高频库存读写。
MySQL 留给最终订单落库，避免被秒杀入口打穿。
```

需要注意：

```text
读取 Redis 库存并抽奖这一步只是“选候选奖品”，不是最终准入。
最终是否拿到资格由 Redis Lua 原子准入决定。
```

## 3. Redis Lua 原子准入

代码位置：

```text
internal/database/admission.go
internal/service/lottery.go
```

这是当前项目最重要的可靠性升级点。

原来链路是 Go 连续执行多条 Redis 命令：

```text
DECR 库存
SET 临时订单
```

单个 `DECR` 是原子的，但“扣库存 + 写临时订单 + 防重复”这个业务动作不是原子的。

现在改为 Redis Lua 脚本一次完成：

```text
1. 检查用户是否已经有临时订单 porder_{uid}
2. 检查奖品库存 gift_count_{giftID} 是否大于 0
3. 扣减库存
4. 写入临时订单 porder_{uid} = giftID，并设置支付超时时间
5. 返回 OK / DUPLICATE / SOLD_OUT
```

为什么 Lua 更可靠：

```text
Redis 执行 Lua 脚本时不会被其他 Redis 命令插队。
所以检查、扣减、写临时订单是一个整体。
```

它保证的是：

```text
同一个用户不能重复抢占多个库存
库存不足时不会发放资格
扣库存和临时订单不会只成功一半
```

它解决的是“秒杀资格发放”的一致性，而不只是“库存数字不小于 0”。

## 4. MQ 延时取消消息

代码位置：

```text
internal/mq/producer.go
internal/mq/consumer.go
internal/service/lottery.go
```

Redis Lua 准入成功后，服务发送 RocketMQ 延时取消消息：

```text
用户拿到资格 -> 发一条延时取消消息 -> 到期后检查是否支付
```

为什么需要 MQ：

```text
用户抢到资格后不一定支付。
如果不做超时补偿，库存会长期被临时订单占住。
MQ 延时消息负责在支付超时后自动回收资格。
```

如果 MQ 发送失败：

```text
服务会调用 Redis Lua 释放脚本，删除临时订单并回补库存。
```

当前边界：

```text
如果进程在“Redis 准入成功后、MQ 发送前”直接崩溃，仍然可能留下没有取消消息的临时订单。
生产中通常用本地消息表 / outbox / 事务消息进一步兜底。
```

## 5. 支付、放弃和超时释放

代码位置：

```text
internal/service/order.go
internal/mq/consumer.go
internal/database/admission.go
```

项目有三种结束资格的方式：

```text
用户支付成功
用户主动放弃
MQ 超时取消
```

放弃和超时取消都走 Redis Lua 释放脚本：

```text
1. 检查 porder_{uid} 是否仍然等于 giftID
2. 如果匹配，删除临时订单
3. 回补库存 gift_count_{giftID}
4. 如果不匹配，说明已经支付、过期或被其他流程处理，不重复回补
```

为什么要这样做：

```text
释放库存必须和删除临时订单绑定。
否则可能出现重复回补、误删别人的临时订单、或者已支付订单又被超时回滚。
```

支付会先走 Redis Lua 认领脚本：

```text
1. 检查 porder_{uid} 是否仍然等于 giftID
2. 如果匹配，删除临时订单
3. 再创建 MySQL 正式订单
```

它保证的是：

```text
支付和超时取消不会同时成功处理同一个临时订单。
```

当前边界：

```text
支付认领 Redis 资格后，如果进程在写 MySQL 正式订单前崩溃，仍可能出现资格已删除但订单未落库。
生产中需要订单状态机、唯一索引、事务消息或 outbox 来继续增强。
```

## 6. MySQL 最终订单

代码位置：

```text
internal/database/order.go
internal/service/order.go
```

MySQL 只在用户支付时写正式订单。

为什么这样拆：

```text
秒杀入口只发资格，不直接写最终订单。
高并发请求被 Redis 和 MQ 吸收。
MySQL 只承接成功支付后的低频确定性写入。
```

当前项目已经具备的兜底：

```text
订单包含 activity_id
user_id + activity_id 有唯一索引，防止同一用户在同一活动重复落库
应用启动时会按 inventory.count - orders 聚合结果恢复 Redis 库存
```

仍建议继续增强：

```text
订单状态从 INIT / PAID / CANCELED 明确流转
支付成功事件也走消息或 outbox，保证最终一致
```

## 7. 指标和可观测性

代码位置：

```text
internal/metrics/metrics.go
internal/handler/metrics.go
views/js/seckill-lab.js
```

页面右侧通过 SSE 展示服务端真实指标：

```text
当前请求数
成功进入队列
被限流拦截
库存不足失败
MQ 待消费消息
已完成订单
P95 / P99 / QPS
是否发生超卖
```

为什么重要：

```text
秒杀系统不是只要“能跑”。
它需要在压测中证明：
请求很多时，库存不会负数；
成功数不会超过库存；
失败原因可解释；
MQ 积压和异步补偿可观察。
```

## 当前可靠性结论

当前项目已经能证明：

```text
Redis 发放资格是原子的
同一个用户不能重复占库存
MySQL 通过 activity_id + user_id 唯一索引兜住重复落库
服务重启时 Redis 库存会按已完成订单恢复
库存不足不会继续发放资格
MQ 失败、用户放弃、支付超时会回补库存
支付和超时释放不会同时处理同一个临时订单
指标面板展示的是服务端真实埋点
```

当前项目还没有完全覆盖：

```text
多实例全局限流
进程崩溃后的 outbox 兜底
完整订单状态机
Redis 高可用和降级策略
MQ 消息重复投递下的完整幂等表
```

所以它现在的定位是：

```text
一个能讲清楚秒杀核心链路的教学型并发系统。
```

下一步如果继续向生产级靠近，优先顺序建议是：

```text
1. 订单状态机
2. Redis 准入成功后的 outbox 可靠消息
3. 分布式限流和用户/IP 维度限流
4. MQ 消费幂等表
5. Redis / MySQL / MQ 高可用部署
```
