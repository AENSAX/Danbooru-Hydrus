# Danbooru -> Hydrus

一个面向 `Danbooru` 帖子页和列表页的油猴脚本，用来把图片直接发送到本地 `Hydrus`，并同时写入页面标签。

## 功能

- 在 `https://danbooru.donmai.us/posts/<id>` 页面显示单图导入按钮
- 在 `https://danbooru.donmai.us/posts?page=2&tags=...` 这类列表页显示批量导入按钮
- 读取当前帖子 JSON 数据
- 下载当前帖子原图
- 上传文件到本地 `Hydrus Client API`
- 自动写入 Danbooru 标签
- 支持按 CSV 对照表翻译标签，并保留原标签
- 若文件曾被物理删除，自动清除删除记录后重试上传一次
- 可选在检测到重复文件时删除旧文件，再重新上传覆盖
- 自动关联帖子 URL 和原图 URL

## 标签策略

- 普通标签：`tag_string_general`
- 作者标签：`artist:*`
- 角色标签：`character:*`
- 作品标签：`series:*`
- 物种标签：`species:*`
- 设定标签：`lore:*`
- 元标签：`tag_string_meta`
- 分级标签：`rating:safe|questionable|explicit`
- 帖子标识：`danbooru:<post_id>`

如果配置了标签翻译 CSV 链接，脚本会在上传前把标签改写为“原标签 + 空格 + 翻译”形式，例如：

- 原标签：`1girl`
- CSV 行：`1girl,0,1个女性`
- 最终标签：`1girl 1个女性`

## 安装方法

1. 安装浏览器扩展 `Tampermonkey`
2. 新建脚本
3. 将 `UpLoader.js:1` 全部内容粘贴进去并保存
4. 打开任意 Danbooru 帖子页

## Hydrus 端准备

在 `Hydrus` 客户端中：

1. 打开 `services -> manage services`
2. 启用 `Client API`
3. 记下 API 地址，默认通常是 `http://127.0.0.1:45869`
4. 创建一个带这些权限的 `Access Key`
   - `Import Files`
   - `Add Tags`
   - `Import URLs`
   - `Search Files`

## 脚本配置

安装脚本后，在 Tampermonkey 菜单中配置：

- `设置 Hydrus API 地址`
- `设置 Access Key`
- `设置标签服务名`
- `设置标签翻译地址`
- `切换重复文件覆盖重传`
- `测试 Hydrus 连接`

默认标签服务名为 `my tags`。

`切换重复文件覆盖重传` 默认关闭。

- 关闭时：若 Hydrus 返回重复文件，脚本沿用原有行为，只补写标签
- 开启时：若 Hydrus 返回重复文件，脚本会先删除本地库中的旧文件，再重新上传当前文件
- 这个选项会执行物理删除并重传，适合你明确想“用当前上传重新覆盖旧记录”的情况

### 标签翻译 CSV 格式

CSV 每行使用以下格式：

- `原标签,0,翻译标签`

例如：

- `1girl,0,1个女性`
- `blue_hair,0,蓝发`

说明：

- 第二列固定为 `0`
- 脚本会保留原标签，并把翻译追加在后面
- 这里填写的是一个可访问的 HTTP 链接，例如 `http://127.0.0.1:8765/translations.csv`
- 不配置该项时，脚本保持原有行为，不做翻译

## 本地翻译服务器

仓库里提供了一个本地服务器脚本：`tag-translation-server.py`。

它会把你指定的 CSV 文件通过 HTTP 暴露出来，这样油猴脚本就可以读取了。

### 启动方法

1. 准备一个 CSV 文件，例如 `translations.csv`
2. 在仓库目录打开终端
3. 运行：

   `python tag-translation-server.py --csv translations.csv`

4. 启动后会看到类似输出：

   `http://127.0.0.1:8765/translations.csv`

5. 把这个链接填入油猴菜单里的 `设置标签翻译地址`

### 可选参数

- `--host`：监听地址，默认 `127.0.0.1`
- `--port`：端口，默认 `8765`
- `--csv`：要暴露的 CSV 文件路径，默认 `translations.csv`

### 示例

- 使用默认文件名启动：`python tag-translation-server.py`
- 指定文件启动：`python tag-translation-server.py --csv E:\\tags\\danbooru.csv`
- 指定端口启动：`python tag-translation-server.py --port 9000 --csv translations.csv`

## 使用方法

1. 打开 Danbooru 帖子页
2. 点击右下角 `传送到 Hydrus`
3. 脚本会自动执行：
   - 拉取帖子元数据
   - 下载原图
   - 上传到 Hydrus
   - 写入标签
   - 关联帖子 URL

### 批量导入当前页

1. 打开 `Danbooru` 的帖子列表页，例如 `https://danbooru.donmai.us/posts?page=2&tags=ordfav%3Aaxijx`
2. 点击右下角 `批量导入本页`
3. 确认后，脚本会按当前页顺序逐张导入这一页的帖子
4. 导入完成后会提示成功数和失败数
