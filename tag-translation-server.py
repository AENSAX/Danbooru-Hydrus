from __future__ import annotations

import argparse
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='启动一个本地 HTTP 服务器，把标签翻译 CSV 暴露为可访问链接。'
    )
    parser.add_argument(
        '--host',
        default='127.0.0.1',
        help='监听地址，默认 127.0.0.1',
    )
    parser.add_argument(
        '--port',
        type=int,
        default=8765,
        help='监听端口，默认 8765',
    )
    parser.add_argument(
        '--csv',
        default='translations.csv',
        help='要暴露的 CSV 文件路径，默认当前目录下的 translations.csv',
    )
    return parser


def create_handler(csv_path: Path) -> type[BaseHTTPRequestHandler]:
    class TranslationHandler(BaseHTTPRequestHandler):
        server_version = 'TagTranslationServer/1.0'

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == '/':
                self._send_index(csv_path)
                return

            if parsed.path == '/healthz':
                self._send_text(200, 'ok\n', 'text/plain; charset=utf-8')
                return

            if parsed.path == '/translations.csv':
                self._send_csv(csv_path)
                return

            self._send_text(404, 'not found\n', 'text/plain; charset=utf-8')

        def log_message(self, format: str, *args: object) -> None:
            print(f'[{self.log_date_time_string()}] {self.address_string()} - {format % args}')

        def _send_index(self, target_csv: Path) -> None:
            exists = target_csv.exists()
            status = '已找到' if exists else '未找到'
            body = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Tag Translation Server</title>
</head>
<body>
  <h1>Tag Translation Server</h1>
  <p>CSV 文件：<code>{html.escape(str(target_csv))}</code></p>
  <p>状态：{status}</p>
  <p>油猴脚本里填写这个地址：</p>
  <p><code>http://{html.escape(self.server.server_address[0])}:{self.server.server_address[1]}/translations.csv</code></p>
  <p>健康检查：</p>
  <p><code>http://{html.escape(self.server.server_address[0])}:{self.server.server_address[1]}/healthz</code></p>
</body>
</html>
"""
            self._send_bytes(200, body.encode('utf-8'), 'text/html; charset=utf-8')

        def _send_csv(self, target_csv: Path) -> None:
            try:
                content = target_csv.read_bytes()
            except FileNotFoundError:
                self._send_text(
                    404,
                    f'CSV 文件不存在：{target_csv}\n',
                    'text/plain; charset=utf-8',
                )
                return

            self._send_bytes(200, content, 'text/csv; charset=utf-8')

        def _send_text(self, status: int, text: str, content_type: str) -> None:
            self._send_bytes(status, text.encode('utf-8'), content_type)

        def _send_bytes(self, status: int, content: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            self.wfile.write(content)

    return TranslationHandler


def main() -> None:
    parser = build_argument_parser()
    args = parser.parse_args()

    csv_path = Path(args.csv).expanduser()
    if not csv_path.is_absolute():
        csv_path = (Path.cwd() / csv_path).resolve()
    else:
        csv_path = csv_path.resolve()

    if not csv_path.exists():
        print('提示：CSV 文件暂未找到，启动后访问 /translations.csv 会返回 404。')
        print(f'      当前路径：{csv_path}')

    server = ThreadingHTTPServer((args.host, args.port), create_handler(csv_path))
    base_url = f'http://{args.host}:{args.port}'

    print('标签翻译服务器已启动')
    print(f'CSV 文件：{csv_path}')
    print(f'首页：{base_url}/')
    print(f'CSV 链接：{base_url}/translations.csv')
    print(f'健康检查：{base_url}/healthz')
    print('按 Ctrl+C 停止服务器')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n正在停止服务器...')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
