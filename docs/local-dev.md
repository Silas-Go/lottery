# 本地开发启动方式

开发时不要把 Go app 放进 Docker 里反复 build。Docker 只负责 MySQL、Redis、RocketMQ，Go app 在本机直接运行。

这套本地开发方式通过脚本只启动依赖容器。不要直接执行 `docker compose up -d`，那会按主 compose 启动完整容器栈，包括 Go app 容器。

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

远程最新的真实压测能力已经合进来了。完整容器部署时，页面生成的默认 wrk2 命令会打到 `app` 容器；本机 Go app 模式下，用下面这个脚本，它会把 wrk2 的目标改成宿主机的 `localhost:5678`，并且加 `--no-deps`，不会顺手启动 Go app 容器：

```powershell
.\scripts\run-local-loadtest.ps1 -Rate 500 -Duration 30s -Connections 128
```

浏览器保持打开 `http://localhost:5678/`，右侧指标面板会通过 `/api/metrics/stream` 看到真实服务端指标。

## 停止依赖

```powershell
.\scripts\stop-infra.ps1
```

这只会停止容器，不会删除 MySQL、Redis、RocketMQ 的数据卷。

## 完整容器部署

只有真正要验证完整 Docker 部署时才 build app 镜像：

```powershell
docker compose up -d --build
```

平时开发不要用这条命令，否则会再次碰到 Docker Hub 基础镜像拉取问题。
