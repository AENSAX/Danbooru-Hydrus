"""封装 Hydrus Client API 的连接检测、文件上传和标签写入流程。"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib import error, parse, request

logger = logging.getLogger("hydrus_uploader_tagger.hydrus")


@dataclass(frozen=True)
class HydrusConfig:
    """Hydrus 连接所需的最小配置。"""

    api_base_url: str
    access_key: str
    tag_service_name: str


@dataclass(frozen=True)
class HydrusConnectionInfo:
    """Hydrus 连接检测后的结果。"""

    api_version: int
    tag_service_key: str


class HydrusService:
    """通过 Hydrus Client API 上传文件并写入标签。"""

    def __init__(self) -> None:
        self._tag_service_key_cache: dict[tuple[str, str], str] = {}

    def check_connection(self, config: HydrusConfig) -> HydrusConnectionInfo:
        """检测 Hydrus 服务是否可用，并解析目标标签服务 key。"""
        logger.info(
            "Hydrus connection check started api_base_url=%s tag_service_name=%s",
            config.api_base_url,
            config.tag_service_name,
        )
        api_version_response = self._request_json("GET", "/api_version", config)
        api_version = int(api_version_response.get("version", 0))
        tag_service_key = self.resolve_tag_service_key(config)
        logger.info(
            "Hydrus connection check succeeded api_version=%s tag_service_key=%s",
            api_version,
            tag_service_key,
        )
        return HydrusConnectionInfo(api_version=api_version, tag_service_key=tag_service_key)

    def resolve_tag_service_key(self, config: HydrusConfig) -> str:
        """根据标签服务名解析 Hydrus 内部使用的 service key。"""
        cache_key = (config.api_base_url, config.tag_service_name)
        cached = self._tag_service_key_cache.get(cache_key)
        if cached:
            logger.info(
                "Hydrus tag service key cache hit api_base_url=%s tag_service_name=%s",
                config.api_base_url,
                config.tag_service_name,
            )
            return cached

        query = parse.urlencode({"service_name": config.tag_service_name})
        result = self._request_json("GET", f"/get_service?{query}", config)
        service_key = str(result.get("service", {}).get("service_key", "")).strip()
        if not service_key:
            raise ValueError(f"Hydrus tag service not found: {config.tag_service_name}")

        self._tag_service_key_cache[cache_key] = service_key
        logger.info(
            "Hydrus tag service key resolved api_base_url=%s tag_service_name=%s tag_service_key=%s",
            config.api_base_url,
            config.tag_service_name,
            service_key,
        )
        return service_key

    def upload_file(self, image_bytes: bytes, config: HydrusConfig) -> dict[str, Any]:
        """上传二进制图片到 Hydrus。"""
        logger.info(
            "Hydrus file upload started api_base_url=%s bytes=%s",
            config.api_base_url,
            len(image_bytes),
        )
        url = f"{config.api_base_url}/add_files/add_file"
        req = request.Request(
            url=url,
            data=image_bytes,
            method="POST",
            headers={
                "Content-Type": "application/octet-stream",
                "Accept": "application/json",
                "Hydrus-Client-API-Access-Key": config.access_key,
            },
        )
        result = self._perform_json_request(req)
        logger.info(
            "Hydrus file upload finished status=%s hash=%s note=%s",
            result.get("status"),
            result.get("hash"),
            result.get("note"),
        )
        return result

    def add_tags(self, hash_value: str, tags: list[str], config: HydrusConfig) -> None:
        """把标签写入指定的 Hydrus 标签服务。"""
        if not tags:
            logger.info("Hydrus add_tags skipped because tag list is empty hash=%s", hash_value)
            return

        tag_service_key = self.resolve_tag_service_key(config)
        logger.info(
            "Hydrus add_tags started hash=%s tag_count=%s tag_service_name=%s tag_service_key=%s",
            hash_value,
            len(tags),
            config.tag_service_name,
            tag_service_key,
        )
        self._request_json(
            "POST",
            "/add_tags/add_tags",
            config,
            body={
                "hash": hash_value,
                "service_keys_to_tags": {
                    tag_service_key: tags,
                },
            },
        )
        logger.info("Hydrus add_tags finished hash=%s tag_count=%s", hash_value, len(tags))

    def clean_tags(self, tags: list[str], config: HydrusConfig) -> list[str]:
        """调用 Hydrus 的 clean_tags 接口，让上传前的标签格式与客户端规则一致。"""
        if not tags:
            logger.info("Hydrus clean_tags skipped because tag list is empty")
            return []

        query = parse.urlencode({"tags": json.dumps(tags, ensure_ascii=False)})
        logger.info("Hydrus clean_tags started tag_count=%s", len(tags))
        result = self._request_json("GET", f"/add_tags/clean_tags?{query}", config)
        cleaned_tags = result.get("tags")
        if isinstance(cleaned_tags, list) and cleaned_tags:
            normalized_tags = [str(tag).strip() for tag in cleaned_tags if str(tag).strip()]
            logger.info("Hydrus clean_tags finished input_count=%s output_count=%s", len(tags), len(normalized_tags))
            return normalized_tags

        logger.info("Hydrus clean_tags returned empty payload, fallback to original tags input_count=%s", len(tags))
        return tags

    def associate_urls(self, hash_value: str, source_urls: list[str], config: HydrusConfig) -> None:
        """把来源 URL 关联到已导入的 Hydrus 文件。"""
        normalized_urls = [str(url).strip() for url in source_urls if str(url).strip()]
        if not normalized_urls:
            logger.info("Hydrus associate_urls skipped because url list is empty hash=%s", hash_value)
            return

        logger.info("Hydrus associate_urls started hash=%s url_count=%s", hash_value, len(normalized_urls))
        self._request_json(
            "POST",
            "/add_urls/associate_url",
            config,
            body={
                "hash": hash_value,
                "urls_to_add": normalized_urls,
            },
        )
        logger.info("Hydrus associate_urls finished hash=%s url_count=%s", hash_value, len(normalized_urls))

    def upload_with_tags(
        self,
        image_bytes: bytes,
        tags: list[str],
        source_urls: list[str] | None,
        config: HydrusConfig,
    ) -> dict[str, Any]:
        """上传文件并在成功后写入标签。"""
        logger.info(
            "Hydrus upload_with_tags started tag_count=%s source_url_count=%s",
            len(tags),
            len(source_urls or []),
        )
        cleaned_tags = self.clean_tags(tags, config)
        import_result = self.upload_file(image_bytes, config)
        status = int(import_result.get("status", 0))
        if status not in {1, 2}:
            note = import_result.get("note") or "unknown hydrus import error"
            raise ValueError(f"Hydrus rejected import: {note}")

        hash_value = str(import_result.get("hash", "")).strip()
        if not hash_value:
            raise ValueError("Hydrus import succeeded but did not return file hash")

        self.add_tags(hash_value, cleaned_tags, config)
        self.associate_urls(hash_value, source_urls or [], config)
        logger.info(
            "Hydrus upload_with_tags finished status=%s hash=%s tag_count=%s source_url_count=%s",
            status,
            hash_value,
            len(cleaned_tags),
            len(source_urls or []),
        )
        return import_result

    def _request_json(
        self,
        method: str,
        path: str,
        config: HydrusConfig,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """发送 Hydrus JSON 请求。"""
        logger.info(
            "Hydrus JSON request method=%s path=%s api_base_url=%s has_body=%s",
            method,
            path,
            config.api_base_url,
            body is not None,
        )
        req = request.Request(
            url=f"{config.api_base_url}{path}",
            data=None if method == "GET" else json.dumps(body or {}).encode("utf-8"),
            method=method,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Hydrus-Client-API-Access-Key": config.access_key,
            },
        )
        return self._perform_json_request(req)

    def _perform_json_request(self, req: request.Request) -> dict[str, Any]:
        """执行请求并把响应解析成 JSON。"""
        try:
            with request.urlopen(req, timeout=20) as response:
                payload = response.read().decode("utf-8")
                logger.info(
                    "Hydrus raw response status=%s url=%s body=%s",
                    getattr(response, "status", "unknown"),
                    req.full_url,
                    payload,
                )
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            logger.error(
                "Hydrus HTTP error status=%s url=%s body=%s",
                exc.code,
                req.full_url,
                payload,
            )
            raise ValueError(self._extract_error_message(exc.code, payload)) from exc
        except error.URLError as exc:
            logger.error("Hydrus connection error url=%s reason=%s", req.full_url, exc.reason)
            raise ValueError(f"Failed to connect to Hydrus: {exc.reason}") from exc

        try:
            return json.loads(payload) if payload else {}
        except json.JSONDecodeError as exc:
            logger.error("Hydrus returned invalid JSON url=%s body=%s", req.full_url, payload)
            raise ValueError("Hydrus returned invalid JSON") from exc

    @staticmethod
    def _extract_error_message(status_code: int, payload: str) -> str:
        """从 Hydrus 错误响应里提取更具体的错误信息。"""
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            parsed = {}

        if isinstance(parsed, dict):
            if parsed.get("error"):
                return f"Hydrus request failed: HTTP {status_code} - {parsed['error']}"
            if parsed.get("note"):
                return f"Hydrus request failed: HTTP {status_code} - {parsed['note']}"
        return f"Hydrus request failed: HTTP {status_code}"
