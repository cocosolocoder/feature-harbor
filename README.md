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
- `GET /api/ideas` 返回意见列表（`{ideas: [...]}`），最新的意见排在最前。
- `POST /api/ideas` 提交新意见，请求体为 JSON 对象：`title`（必填，去掉首尾空白后非空、最多 120 字）、`description`（必填，须含非空白内容、最多 5000 字）、`scenario`（可选字符串，省略视为空、最多 1000 字），长度按 Unicode 码点计算。成功返回 201 和 `{idea: {...}}`，包含 `id` 与 `createdAt`；字段缺失、类型或内容不合要求返回 400。
- 未知路径返回 404，已知路径不支持的方法返回 405。
- 首页 `/` 提供提交表单和意见列表，数据保存在 `--data-dir` 指定的目录中，重启后保留。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/ideas
curl -X POST http://127.0.0.1:8080/api/ideas \
  -H 'content-type: application/json' \
  -d '{"title":"支持深色模式","description":"希望界面支持深色模式。","scenario":"夜间使用"}'
```
