# PMTagger Server

`PMTagger`本地 HTTP 服务，负责图片 AI 打标、英文标签翻译、Hydrus 上传和 WebUI 配置。

## 启动

```powershell
cd \PMTaggerServer
uv sync
uv run pmtagger-service
```

默认地址：

- WebUI: `http://127.0.0.1:8000/`
- Swagger: `http://127.0.0.1:8000/docs`

## 修改启动端口

启动前设置 `TAGGER_PORT`：

```powershell
cd \PMTaggerServer
$env:TAGGER_PORT = "8010"
uv run pmtagger-service
```

如果还要修改监听地址：

```powershell
$env:TAGGER_HOST = "0.0.0.0"
$env:TAGGER_PORT = "8010"
uv run pmtagger-service
```

修改后 WebUI 地址示例：

```text
http://127.0.0.1:8010/
```

## WebUI 功能

- 检测 PMTagger 和 Hydrus 连接。
- 配置模型、标签阈值、翻译 CSV、Hydrus API 地址、Access Key、标签服务名。
- 选择本地图片文件夹，批量 AI 打标。
- 将已打标图片上传到 Hydrus。
- 查看每一步操作日志。

网页脚本导入的非本地图片会自动把来源 URL 写入 Hydrus：Danbooru 导入会关联帖子页 URL 和原图 URL，通用网页导入会关联图片 URL 和当前页面 URL。Hydrus Access Key 需要包含 Import URLs 权限。

配置会保存到：

```text
\PMTaggerServer\runtime-config.json
```

## 主要 API

- `GET /health`：服务健康检查。
- `GET /api/v1/connections/check`：检查 PMTagger 与 Hydrus 可用性。
- `GET /api/v1/models`：模型列表。
- `POST /api/v1/models/warmup`：预热模型。
- `GET /api/v1/ui/runtime-config`：读取 WebUI 配置。
- `POST /api/v1/ui/runtime-config`：保存 WebUI 配置。
- `POST /api/v1/ui/runtime-config/translation-csv`：上传并切换翻译 CSV。
- `POST /api/v1/tags/upload`：上传一张图片，只返回 AI 打标和翻译结果。
- `POST /api/v1/tags/upload/batch`：批量上传图片，只返回 AI 打标和翻译结果。
- `POST /api/v1/tags/base64`：使用 base64 图片打标。
- `POST /api/v1/process`：有标签则翻译，无标签则 AI 打标后翻译。
- `POST /api/v1/hydrus/upload/image`：上传单张图片到 Hydrus，`tags` 为空时自动 AI 打标。
- `POST /api/v1/hydrus/upload/images`：上传图片列表到 Hydrus。

`/api/v1/hydrus/upload/image` 与 `/api/v1/hydrus/upload/images` 的图片对象可传入 `source_urls` 字段，格式为字符串数组；传入后 PMTagger 会在 Hydrus 导入成功后自动关联这些 URL。本地文件路径导入如果不传该字段，则不会写入 URL。

如果希望在保留 AI 打标的同时额外附加自定义标签，可以传 `extra_tags` 字段。`tags` 非空会跳过 AI 打标，而 `extra_tags` 会在 AI 打标完成后再合并进最终上传到 Hydrus 的标签列表。

## 油猴脚本对接

- `PMDanBooruSpider.js` 会发送 Danbooru 原图、Danbooru 标签、帖子页 URL 和原图 URL 到 `POST /api/v1/hydrus/upload/image`。
- `PMImageSpider.js` 会发送右键选中的网页图片、图片 URL 和当前页面 URL 到 `POST /api/v1/hydrus/upload/image`，标签为空，因此由 PMTagger 自动 AI 打标。
- `PMEHentaiSpider.js` 会遍历 e-hentai / exhentai 某个 gallery 的所有分页与图片页，抓取实际图片后发送到 `POST /api/v1/hydrus/upload/image`，并附带 gallery 链接、图片页链接和实际图片链接。
