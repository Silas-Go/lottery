# 本地开发启动方式

开发时不要把 Go app 放进 Docker 里反复 build。Docker 只负责 MySQL、Redis、RocketMQ，Go app 在本机直接运行。

主 `docker-compose.yml` 只保留依赖服务和压测工具，不再包含 Go app 服务。也就是说，普通的 `docker compose up -d` 只会启动 MySQL、Redis、RocketMQ，不会 build 或启动 Go app 容器。

## 启动依赖

```powershell
.\scripts\start-infra.ps1
```

## 启动本机 Go app

```powershell
.\scripts\run-local-app.ps1
```

访问：

```text
http://localhost:5678/
```

改 Go 代码后，在运行 app 的终端按 `Ctrl+C`，再执行：

```powershell
.\scripts\run-local-app.ps1
```

改 `views` 下的前端文件后，本机 Go app 重启即可重新加载 HTML；CSS、JS、图片通常强刷浏览器即可。

## 本机 Go app 压测

远程最新的真实压测能力已经合进来了。现在 `wrk2` 默认打到宿主机上的 `localhost:5678`，不会启动 Go app 容器：

```powershell
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128
```

浏览器保持打开 `http://localhost:5678/`，右侧指标面板会通过 `/api/metrics/stream` 看到真实服务端指标。

## 停止依赖

```powershell
.\scripts\stop-infra.ps1
```

这只会停止容器，不会删除 MySQL、Redis、RocketMQ 的数据卷。

## 默认启动

如果你只是本机开发，不需要 build Go app 镜像。现在默认部署就是：

```powershell
docker compose up -d
```
