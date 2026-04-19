# PMTagger

一个面向 Hydrus 的图片入库工具链，用来把网页图片或本地图片发送到本地服务，完成 AI 打标、标签翻译，并最终上传到 Hydrus。

## 项目组成

- `PMTagger`：PMTagger 本地 HTTP 服务和 WebUI，负责模型打标、翻译、Hydrus 上传。
- `PMDanBooruSpider.js`：Danbooru 专用油猴脚本，能读取 Danbooru 帖子标签并发送到 PMTagger。
- `PMImageSpider.js`：通用网页油猴脚本，适用于所有网页，右键图片即可发送到 PMTagger。
- `PMEHentaiSpider.js`：e-hentai / exhentai 画廊批量抓取脚本，能抓取整本 gallery 的所有图片并发送到 PMTagger。
- `translations.csv`：默认标签翻译词表，形如：1girl,0,1个女性。
## PMTagger 服务

进入服务目录：

```powershell
cd \PMTaggerServer
uv sync
```

启动服务：

```powershell
uv run pmtagger-service
```

默认地址：

- WebUI: `http://127.0.0.1:8000/`
- API 文档: `http://127.0.0.1:8000/docs`
- 健康检查: `http://127.0.0.1:8000/health`

## 修改启动端口

启动前设置环境变量即可：

```powershell
cd \PMTaggerServer
$env:TAGGER_PORT = "8010"
uv run pmtagger-service
```

如果还想修改监听地址，例如允许局域网访问：

```powershell
$env:TAGGER_HOST = "0.0.0.0"
$env:TAGGER_PORT = "8010"
uv run pmtagger-service
```

修改后访问地址会变成：

```text
http://127.0.0.1:8010/
```

## 基本流程

1. 启动 Hydrus，并确保 Client API 可用。
2. 启动 PMTagger 服务。
3. 打开 `http://127.0.0.1:8000/`。
4. 在 WebUI 中配置 Hydrus API 地址、Access Key、标签服务名。
5. 保存配置，配置会写入 `PMTaggerServer/runtime-config.json`，重启后仍会保留。
6. 安装 `PMDanBooruSpider.js` 或 `PMImageSpider.js` 油猴脚本。
7. 在网页上把图片发送给 PMTagger。

## 上传标签策略

PMTagger 上传到 Hydrus 前会把标签翻译追加到英文标签后面，例如：

```text
1girl 1个女性
solo 单独人物
```

如果某个标签没有翻译命中，则保留英文原标签。PMDanBooruSpider 会把 Danbooru 已有标签交给 PMTagger；PMImageSpider 对普通网页图片不提供标签，PMTagger 会自动 AI 打标后翻译。

网页来源图片上传到 Hydrus 时会自动关联来源 URL：PMDanBooruSpider 会写入 Danbooru 帖子页 URL 和原图 URL，PMImageSpider 会写入图片 URL 和当前页面 URL。本地文件夹导入不会自动写 URL。Hydrus Access Key 需要包含 Import URLs 权限。

## 使用教程

详细教程见：

- [使用教程](docs/使用教程.md)

其中包括：

- PMTagger 服务配置
- PMDanBooruSpider 用法
- PMImageSpider 用法
- PMEHentaiSpider 用法

翻译文件来自：https://github.com/DominikDoom/a1111-sd-webui-tagcomplete/discussions/23
