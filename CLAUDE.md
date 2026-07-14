# CLAUDE.md

Go 秒杀/抽奖系统演示项目。完整指南见 [AGENTS.md](AGENTS.md)。

## 关键约束速查

- **默认结构：** 全容器化运行（Go app + MySQL/Redis/RocketMQ 统一在 Docker Compose 网络），`docker compose up -d --build app` 一条命令启动
- **统一状态机：** 两个模式都只允许 `stock_acquired -> pending_payment -> paid/cancelled`，终态不可复活
- **Redis Lua 是并发边界：** Redis 模式的准入、支付、取消必须通过 Lua 状态迁移，绝不退化为普通命令拼接
- **MySQL 事务是同步模式边界：** MySQL 模式必须原子完成库存扣减和 `pending_payment` 订单创建
- **MQ 职责分离：** `CREATE_ORDER` 普通消息异步削峰，`CANCEL_ORDER` 延迟消息只做超时检查
- **修改关键链路：** 同步补日志（slog）+ 业务错误码 + HTTP 状态码 + metrics 指标
- **注释：** 解释设计意图/并发边界/失败兜底，不解释语法；英文命名必须注释中文业务语义
- **验证：** `go test ./... -run '^$'` + `docker compose config --quiet`
