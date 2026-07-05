# CLAUDE.md

Go 秒杀/抽奖系统演示项目。完整指南见 [AGENTS.md](AGENTS.md)。

## 关键约束速查

- **默认结构：** 全容器化运行（Go app + MySQL/Redis/RocketMQ 统一在 Docker Compose 网络），`docker compose up -d --build app` 一条命令启动
- **Redis Lua 是原子边界：** 防重复+扣库存+写临时资格必须在一个 Lua 脚本完成，绝不退化为多条普通 Redis 命令
- **MySQL 只写最终订单：** 不参与入口高并发扣库存（预扣模式下）；Cache-Aside 模式打 MySQL 是刻意对比
- **修改关键链路：** 同步补日志（slog）+ 业务错误码 + HTTP 状态码 + metrics 指标
- **注释：** 解释设计意图/并发边界/失败兜底，不解释语法；英文命名必须注释中文业务语义
- **验证：** `go test ./... -run '^$'` + `docker compose config --quiet`
