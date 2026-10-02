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
- `GET /api/ideas` 返回意见列表，首次启动时为空，新意见排在最前面。
- `POST /api/ideas` 提交产品意见，请求体为 JSON 对象，包含：
  - `title`（必填）：标题，字符串，去掉首尾空白后不能为空，最多 120 个字符，保存去掉首尾空白后的值。
  - `description`（必填）：详细说明，字符串，必须包含非空白内容，最多 5000 个字符，保留原有换行和首尾空白。
  - `scenario`（可选）：使用场景，字符串，可不填，最多 1000 个字符，保留原有换行和首尾空白；省略时视为空字符串。
  - 长度均按 Unicode 码点计算。成功返回 `201` 和 `{idea: 记录}`，记录包含三个字段、稳定且不重复的 `id` 以及服务端生成的 `createdAt`（带时区的 ISO 格式）。
- 未知路径返回 404，已知路径不支持的方法返回 405（`/api/ideas` 声明支持 `GET, POST`）。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/ideas
curl -X POST http://127.0.0.1:8080/api/ideas \
  -H 'content-type: application/json' \
  -d '{"title":"支持深色模式","description":"希望在夜间使用时切换深色主题。","scenario":"晚上关灯后浏览"}'
```

数据保存在 `--data-dir` 指定目录下的 `ideas.json` 中，重启后仍然可见。
