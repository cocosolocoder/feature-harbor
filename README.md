# FeatureHarbor

产品意见与公开路线图。

需要Node.js 24 或更新版本。直接运行 TypeScript，不需要安装其他包。

查看命令帮助：

```sh
node server.ts --help
```

启动本地服务：

```sh
node server.ts serve --host 127.0.0.1 --port 8080 --data-dir data
```

打开 http://127.0.0.1:8080 查看首页。Ctrl+C 停止服务。`--data-dir` 指定本地业务数据目录，重启时继续使用同一目录。

接口：

- `GET /health` 返回服务状态和产品名称。
- `GET /api/ideas` 返回意见列表，首次启动时为空。
- 未知路径返回 404，已知路径不支持的方法返回 405。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/ideas
```
