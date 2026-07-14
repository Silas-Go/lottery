# 本地开发启动方式

项目支持两种运行方式。

## 方式一：完整 Docker Compose

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

访问 `http://localhost:5678/`。

`rocketmq-init` 会创建：

- `CREATE_ORDER` 普通 Topic。
- `CANCEL_ORDER` 延迟 Topic。
- `lottery` Consumer Group。

## 方式二：依赖跑 Docker，Go app 跑本机

这种方式适合频繁修改 Go 代码。

```powershell
.\scripts\start-infra.ps1
.\scripts\run-local-app.ps1
```

`start-infra.ps1` 只启动 MySQL、Redis、RocketMQ 和初始化任务；如果存在旧的 `lottery-app` 容器会先移除，避免占用 5678 端口。

修改 Go 代码后，在 app 终端按 `Ctrl+C`，重新执行 `run-local-app.ps1`。前端静态文件通常强刷浏览器即可。

## 本机 app 压测

```powershell
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128
```

默认目标是 `http://host.docker.internal:5678/lucky`。测试 MySQL 同步模式时传入：

```powershell
.\scripts\run-local-loadtest.ps1 -TargetUrl "http://host.docker.internal:5678/lucky/cacheaside"
```

## 停止依赖

```powershell
.\scripts\stop-infra.ps1
```

该命令只停止容器，不删除数据卷。
