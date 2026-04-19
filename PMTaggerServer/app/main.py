"""FastAPI 应用入口，负责把模型服务、翻译服务和 Web UI 串起来。"""

from __future__ import annotations

import base64
import binascii
import logging
from pathlib import Path
import time
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import MODEL_REPO_MAP, get_settings
from app.hydrus_service import HydrusConfig, HydrusService
from app.model_service import PredictionOptions, TaggerModelService
from app.runtime_state import AppRuntimeState
from app.schemas import (
    Base64TagRequest,
    BatchTagItemResponse,
    BatchTagResponse,
    ConnectionCheckResponse,
    ConfigResponse,
    HydrusUploadImageListItem,
    HydrusUploadImageListRequest,
    HydrusUploadImageListResponse,
    HydrusUploadImageRequest,
    HydrusUploadImageResult,
    ModelInfo,
    RuntimeConfigResponse,
    RuntimeConfigUpdateRequest,
    TagProcessRequest,
    TagProcessResponse,
    TagResponse,
    WarmupResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("hydrus_uploader_tagger.app")


# 启动时先读取静态配置，再创建服务级单例对象供路由复用。
settings = get_settings()
service = TaggerModelService(settings)
runtime_state = AppRuntimeState(settings)
hydrus_service = HydrusService()
static_dir = Path(__file__).resolve().parent / "static"


def _mask_secret(value: str | None) -> str:
    """隐藏 access key 等敏感配置，只在日志中保留长度和少量首尾字符。"""
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]} (len={len(value)})"


def _runtime_log_snapshot() -> dict[str, object]:
    """生成可安全打印的运行时配置快照，帮助定位前端配置是否真的传到后端。"""
    runtime_config = runtime_state.get_runtime_config(device_name=service.device_name)
    return {
        "default_model": runtime_config.default_model,
        "general_threshold": runtime_config.general_threshold,
        "character_threshold": runtime_config.character_threshold,
        "translation_csv_path": runtime_config.translation_csv_path,
        "hydrus_api_base_url": runtime_config.hydrus_api_base_url,
        "hydrus_access_key": _mask_secret(runtime_config.hydrus_access_key),
        "hydrus_tag_service_name": runtime_config.hydrus_tag_service_name,
        "device": runtime_config.device,
    }


def _runtime_update_log_payload(request: RuntimeConfigUpdateRequest) -> dict[str, object]:
    """把 Web UI 提交的配置整理成可安全打印的 payload。"""
    payload = request.model_dump()
    payload["hydrus_access_key"] = _mask_secret(request.hydrus_access_key)
    return payload


def _ensure_payload_size(payload: bytes) -> None:
    """统一限制上传体大小，避免超大文件拖垮服务。"""
    if len(payload) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Upload too large, max allowed bytes: {settings.max_upload_bytes}",
        )


def _prediction_options(
    model: str | None,
    general_threshold: float | None,
    character_threshold: float | None,
) -> PredictionOptions:
    """把请求参数转换成经过校验的推理选项。"""
    try:
        return runtime_state.build_prediction_options(
            model,
            general_threshold,
            character_threshold,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _with_translations(result: TagResponse) -> TagResponse:
    """为 AI 打标结果补充中文翻译标签。"""
    return result.model_copy(
        update={"translated_tags": runtime_state.get_translator().translate_tags(result.hydrus_tags)}
    )


def _normalize_tags(tags: list[str] | None = None) -> list[str]:
    """把标签数组整理成去重后的标签列表。"""
    merged: list[str] = []

    if tags:
        merged.extend(tag.strip() for tag in tags if tag.strip())

    deduplicated: list[str] = []
    seen: set[str] = set()
    for tag in merged:
        if tag not in seen:
            deduplicated.append(tag)
            seen.add(tag)
    return deduplicated


def _append_tag_translation(english_tag: str, chinese_tag: str | None) -> str:
    """把中文翻译追加到英文 tag 后面。"""
    normalized_english = english_tag.strip()
    normalized_chinese = (chinese_tag or "").strip()
    if not normalized_english or not normalized_chinese or normalized_chinese == normalized_english:
        return normalized_english
    return f"{normalized_english} {normalized_chinese}"


def _normalize_source_urls(source_urls: list[str] | None = None) -> list[str]:
    """整理来源 URL，去掉空字符串和重复项。"""
    normalized_urls: list[str] = []
    seen: set[str] = set()
    for url in source_urls or []:
        normalized_url = str(url).strip()
        if not normalized_url or normalized_url in seen:
            continue
        normalized_urls.append(normalized_url)
        seen.add(normalized_url)
    return normalized_urls


def _build_hydrus_upload_tags(english_tags: list[str], translated_tags) -> list[str]:
    """把英文标签和翻译结果合成最终上传给 Hydrus 的双语标签列表。"""
    translation_by_english: dict[str, str] = {}
    for item in translated_tags:
        english_tag = item.english_tag.strip()
        chinese_tag = item.base_chinese_tag.strip() if item.found and item.base_chinese_tag else ""
        if english_tag:
            translation_by_english[english_tag] = chinese_tag

    merged_tags: list[str] = []
    for english_tag in english_tags:
        merged_tags.append(_append_tag_translation(english_tag, translation_by_english.get(english_tag)))
    return _normalize_tags(merged_tags)


def _merge_extra_tags(base_tags: list[str], extra_tags: list[str] | None = None) -> list[str]:
    """把附加标签合并到最终上传标签里，同时保持去重。"""
    merged_tags: list[str] = []
    merged_tags.extend(base_tags)
    if extra_tags:
        merged_tags.extend(extra_tags)
    return _normalize_tags(merged_tags)


def _load_metadata(metadata: dict[str, object] | None) -> dict[str, object] | None:
    """整理请求体里的 metadata。"""
    return dict(metadata) if metadata else None


def _hydrus_config_from_runtime() -> HydrusConfig:
    """从当前运行时配置构建 Hydrus 连接配置。"""
    runtime_config = runtime_state.get_runtime_config(device_name=service.device_name)
    if not runtime_config.hydrus_api_base_url.strip():
        raise HTTPException(status_code=400, detail="Hydrus API base URL is not configured")
    if not runtime_config.hydrus_access_key.strip():
        raise HTTPException(status_code=400, detail="Hydrus access key is not configured")
    if not runtime_config.hydrus_tag_service_name.strip():
        raise HTTPException(status_code=400, detail="Hydrus tag service name is not configured")

    return HydrusConfig(
        api_base_url=runtime_config.hydrus_api_base_url.strip(),
        access_key=runtime_config.hydrus_access_key.strip(),
        tag_service_name=runtime_config.hydrus_tag_service_name.strip(),
    )


def _load_image_input(
    *,
    image_path: str | None = None,
    image_base64: str | None = None,
    filename: str | None = None,
) -> tuple[bytes, str | None, str | None]:
    """从本地路径或 base64 中读取图片输入。"""
    if image_path:
        path = Path(image_path).expanduser().resolve()
        if not path.is_file():
            raise HTTPException(status_code=400, detail=f"Image file does not exist: {path}")
        return path.read_bytes(), filename or path.name, str(path)

    if image_base64:
        try:
            return base64.b64decode(image_base64, validate=True), filename, None
        except binascii.Error as exc:
            raise HTTPException(status_code=400, detail="image_base64 is not valid base64") from exc

    raise HTTPException(status_code=400, detail="image_path or image_base64 is required")


def _process_core(
    *,
    image_bytes: bytes | None,
    filename: str | None,
    tags: list[str] | None,
    metadata: dict[str, object] | None,
    model: str | None,
    general_threshold: float | None,
    character_threshold: float | None,
) -> TagProcessResponse:
    """统一处理直接翻译标签和AI 打标再翻译"""
    provided_tags = _normalize_tags(tags=tags)
    if provided_tags:
        return TagProcessResponse(
            filename=filename,
            metadata=metadata,
            source="provided_tags",
            model=model,
            english_tags=provided_tags,
            translated_tags=runtime_state.get_translator().translate_tags(provided_tags),
            ai_result=None,
        )

    if image_bytes is None:
        raise HTTPException(
            status_code=400,
            detail="image data is required when tags are not provided",
        )

    # 只有在没有手动标签时，才会真正进入模型推理流程。
    _ensure_payload_size(image_bytes)
    result = _with_translations(
        service.predict_bytes(
            image_bytes=image_bytes,
            filename=filename,
            options=_prediction_options(
                model,
                general_threshold,
                character_threshold,
            ),
        )
    )
    return TagProcessResponse(
        filename=filename,
        metadata=metadata,
        source="ai_generated_tags",
        model=result.model,
        english_tags=result.hydrus_tags,
        translated_tags=result.translated_tags,
        ai_result=result,
    )


app = FastAPI(
    title="PMTagger",
    version="0.1.0",
    description="PINKMERCY image tagging, translation, and Hydrus upload service.",
)


def _known_routes_for_log() -> str:
    """把当前应用已注册路由整理成一行，专门用于排查 404。"""
    routes: list[str] = []
    for route in app.router.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        routes.append(f"{','.join(sorted(methods))} {path}")
    return " | ".join(sorted(routes))


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    """记录每个 HTTP 请求的入口、状态码和耗时，404 时额外输出已注册路由。"""
    started_at = time.perf_counter()
    client = f"{request.client.host}:{request.client.port}" if request.client else "unknown"
    logger.info(
        "HTTP request started method=%s path=%s query=%s client=%s",
        request.method,
        request.url.path,
        request.url.query,
        client,
    )

    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        logger.exception(
            "HTTP request crashed method=%s path=%s query=%s client=%s elapsed_ms=%.2f",
            request.method,
            request.url.path,
            request.url.query,
            client,
            elapsed_ms,
        )
        raise

    elapsed_ms = (time.perf_counter() - started_at) * 1000
    if response.status_code == 404:
        logger.warning(
            "HTTP request returned 404 method=%s path=%s query=%s client=%s elapsed_ms=%.2f known_routes=%s",
            request.method,
            request.url.path,
            request.url.query,
            client,
            elapsed_ms,
            _known_routes_for_log(),
        )
    elif response.status_code >= 400:
        logger.warning(
            "HTTP request returned error method=%s path=%s query=%s client=%s status=%s elapsed_ms=%.2f",
            request.method,
            request.url.path,
            request.url.query,
            client,
            response.status_code,
            elapsed_ms,
        )
    else:
        logger.info(
            "HTTP request finished method=%s path=%s status=%s elapsed_ms=%.2f",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
    return response


# 挂载静态资源目录，供 Web UI 的 HTML、CSS、JS 和装饰图使用。
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/", include_in_schema=False)
def web_ui() -> FileResponse:
    """返回主 Web UI 页面。"""
    return FileResponse(static_dir / "index.html")


@app.get("/ui", include_in_schema=False)
def web_ui_alias() -> FileResponse:
    """给 Web UI 提供一个可读性更强的别名地址。"""
    return FileResponse(static_dir / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    """健康检查接口，同时回报当前推理设备。"""
    return {"status": "ok", "device": service.device_name}


@app.get("/api/v1/connections/check", response_model=ConnectionCheckResponse)
def check_connections() -> ConnectionCheckResponse:
    """检测服务自身和 Hydrus 连接状态。"""
    logger.info("Connection check route entered runtime_config=%s", _runtime_log_snapshot())
    try:
        hydrus_config = _hydrus_config_from_runtime()
        info = hydrus_service.check_connection(hydrus_config)
        logger.info(
            "Connection check succeeded device=%s hydrus_api_version=%s tag_service_name=%s tag_service_key=%s",
            service.device_name,
            info.api_version,
            hydrus_config.tag_service_name,
            info.tag_service_key,
        )
        return ConnectionCheckResponse(
            service_available=True,
            device=service.device_name,
            hydrus_available=True,
            hydrus_api_version=info.api_version,
            hydrus_tag_service_name=hydrus_config.tag_service_name,
            hydrus_tag_service_key=info.tag_service_key,
            hydrus_error=None,
        )
    except HTTPException as exc:
        logger.warning(
            "Connection check failed because runtime config is invalid detail=%s runtime_config=%s",
            exc.detail,
            _runtime_log_snapshot(),
        )
        return ConnectionCheckResponse(
            service_available=True,
            device=service.device_name,
            hydrus_available=False,
            hydrus_api_version=None,
            hydrus_tag_service_name=None,
            hydrus_tag_service_key=None,
            hydrus_error=str(exc.detail),
        )
    except Exception as exc:
        logger.exception("Connection check failed due to unexpected Hydrus error runtime_config=%s", _runtime_log_snapshot())
        return ConnectionCheckResponse(
            service_available=True,
            device=service.device_name,
            hydrus_available=False,
            hydrus_api_version=None,
            hydrus_tag_service_name=None,
            hydrus_tag_service_key=None,
            hydrus_error=str(exc),
        )


@app.get("/api/v1/models", response_model=list[ModelInfo])
def list_models() -> list[ModelInfo]:
    """返回支持的模型列表以及各模型是否已加载。"""
    logger.info("List models requested")
    loaded_status = service.get_loaded_status()
    return [
        ModelInfo(name=name, repo_id=repo_id, loaded=loaded_status[name])
        for name, repo_id in MODEL_REPO_MAP.items()
    ]


@app.get("/api/v1/config", response_model=ConfigResponse)
def get_config() -> ConfigResponse:
    """返回当前服务对外默认配置。"""
    logger.info("Static config requested")
    runtime_config = runtime_state.get_runtime_config(device_name=service.device_name)
    return ConfigResponse(
        default_model=runtime_config.default_model,
        general_threshold=runtime_config.general_threshold,
        character_threshold=runtime_config.character_threshold,
        max_upload_bytes=runtime_config.max_upload_bytes,
        device=runtime_config.device,
        translation_csv_path=runtime_config.translation_csv_path,
    )


@app.get("/api/v1/ui/runtime-config", response_model=RuntimeConfigResponse)
def get_runtime_config() -> RuntimeConfigResponse:
    """返回 Web UI 当前正在使用的运行时配置。"""
    config = runtime_state.get_runtime_config(device_name=service.device_name)
    logger.info("Runtime config requested snapshot=%s", _runtime_log_snapshot())
    return config


@app.post("/api/v1/ui/runtime-config", response_model=RuntimeConfigResponse)
def update_runtime_config(request: RuntimeConfigUpdateRequest) -> RuntimeConfigResponse:
    """更新 Web UI 使用的运行时配置。"""
    logger.info(
        "Runtime config update requested payload=%s",
        _runtime_update_log_payload(request),
    )
    try:
        config = runtime_state.update_runtime_config(
            request,
            device_name=service.device_name,
        )
        logger.info("Runtime config update succeeded snapshot=%s", _runtime_log_snapshot())
        return config
    except ValueError as exc:
        logger.warning("Runtime config update failed detail=%s payload=%s", exc, _runtime_update_log_payload(request))
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/v1/ui/runtime-config/translation-csv", response_model=RuntimeConfigResponse)
async def upload_translation_csv(file: UploadFile = File(...)) -> RuntimeConfigResponse:
    """接收前端选择的翻译 CSV，并热更新运行时翻译服务。"""
    logger.info(
        "Runtime translation CSV upload requested filename=%s content_type=%s",
        file.filename,
        file.content_type,
    )
    try:
        payload = await file.read()
        config = runtime_state.update_translation_csv_upload(
            payload,
            file.filename,
            device_name=service.device_name,
        )
        logger.info("Runtime translation CSV upload succeeded snapshot=%s", _runtime_log_snapshot())
        return config
    except ValueError as exc:
        logger.warning("Runtime translation CSV upload failed filename=%s detail=%s", file.filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Runtime translation CSV upload crashed filename=%s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/models/warmup", response_model=WarmupResponse)
def warmup_model(model: str | None = None) -> WarmupResponse:
    """预热指定模型，提前触发下载和权重加载。"""
    logger.info("Model warmup requested model=%s", model)
    try:
        target_model = model or runtime_state.get_runtime_config(device_name=service.device_name).default_model
        service.warmup(target_model)
        logger.info("Model warmup succeeded model=%s device=%s", target_model, service.device_name)
        return WarmupResponse(model=target_model, loaded=True, device=service.device_name)
    except HTTPException:
        raise
    except ValueError as exc:
        logger.warning("Model warmup failed model=%s detail=%s", model, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Model warmup crashed model=%s", model)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/process", response_model=TagProcessResponse)
def process_request(request: TagProcessRequest) -> TagProcessResponse:
    """统一处理 JSON 请求：有标签就翻译，没标签就 base64 打标后翻译。"""
    logger.info(
        "Process request started filename=%s provided_tag_count=%s has_image_base64=%s model=%s",
        request.filename,
        len(request.tags or []),
        bool(request.image_base64),
        request.model,
    )
    try:
        payload = None
        normalized_tags = _normalize_tags(tags=request.tags)
        if not normalized_tags:
            if not request.image_base64:
                raise HTTPException(
                    status_code=400,
                    detail="image_base64 is required when tags are not provided",
                )
            payload = base64.b64decode(request.image_base64, validate=True)

        metadata = _load_metadata(request.metadata)
        # 这里不关心输入来源，只把数据整理后交给核心业务函数。
        response = _process_core(
            image_bytes=payload,
            filename=request.filename,
            tags=normalized_tags,
            metadata=metadata,
            model=request.model,
            general_threshold=request.general_threshold,
            character_threshold=request.character_threshold,
        )
        logger.info(
            "Process request succeeded filename=%s source=%s english_tag_count=%s translated_tag_count=%s",
            request.filename,
            response.source,
            len(response.english_tags),
            len(response.translated_tags),
        )
        return response
    except HTTPException:
        logger.warning("Process request failed with HTTPException filename=%s", request.filename, exc_info=True)
        raise
    except binascii.Error as exc:
        logger.warning("Process request failed because image_base64 is invalid filename=%s", request.filename)
        raise HTTPException(status_code=400, detail="image_base64 is not valid base64") from exc
    except ValueError as exc:
        logger.warning("Process request failed filename=%s detail=%s", request.filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Process request crashed filename=%s", request.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

def _upload_single_item(
    *,
    index: int,
    item: HydrusUploadImageListItem,
    model: str | None,
    general_threshold: float | None,
    character_threshold: float | None,
    hydrus_config: HydrusConfig,
) -> HydrusUploadImageResult:
    """上传单张图片到 Hydrus，必要时先自动打标。"""
    logger.info(
        "Hydrus upload item started index=%s image_path=%s filename=%s has_base64=%s provided_tag_count=%s",
        index,
        item.image_path,
        item.filename,
        bool(item.image_base64),
        len(item.tags or []),
    )
    image_bytes, resolved_filename, resolved_path = _load_image_input(
        image_path=item.image_path,
        image_base64=item.image_base64,
        filename=item.filename,
    )
    provided_tags = _normalize_tags(item.tags)
    extra_tags = _normalize_tags(item.extra_tags)
    process_result = _process_core(
        image_bytes=image_bytes,
        filename=resolved_filename,
        tags=provided_tags,
        metadata={"image_path": resolved_path} if resolved_path else None,
        model=model,
        general_threshold=general_threshold,
        character_threshold=character_threshold,
    )
    hydrus_upload_tags = _build_hydrus_upload_tags(
        process_result.english_tags,
        process_result.translated_tags,
    )
    hydrus_upload_tags = _merge_extra_tags(hydrus_upload_tags, extra_tags)
    source_urls = _normalize_source_urls(item.source_urls)
    import_result = hydrus_service.upload_with_tags(
        image_bytes=image_bytes,
        tags=hydrus_upload_tags,
        source_urls=source_urls,
        config=hydrus_config,
    )
    result = HydrusUploadImageResult(
        index=index,
        filename=resolved_filename,
        image_path=resolved_path,
        success=True,
        hydrus_hash=str(import_result.get("hash", "")).strip() or None,
        hydrus_status=int(import_result.get("status", 0) or 0),
        used_ai_tags=not bool(provided_tags),
        english_tags=process_result.english_tags,
        translated_tags=process_result.translated_tags,
    )
    logger.info(
        "Hydrus upload item succeeded index=%s filename=%s image_path=%s hash=%s status=%s used_ai_tags=%s english_tag_count=%s hydrus_upload_tag_count=%s extra_tag_count=%s source_url_count=%s",
        index,
        resolved_filename,
        resolved_path,
        result.hydrus_hash,
        result.hydrus_status,
        result.used_ai_tags,
        len(result.english_tags),
        len(hydrus_upload_tags),
        len(extra_tags),
        len(source_urls),
    )
    return result


@app.post("/api/v1/hydrus/upload/image", response_model=HydrusUploadImageResult)
def hydrus_upload_image(request: HydrusUploadImageRequest) -> HydrusUploadImageResult:
    """上传单张图片到 Hydrus；tags 为空时自动打标并翻译。"""
    logger.info(
        "Hydrus single upload requested image_path=%s filename=%s has_base64=%s provided_tag_count=%s",
        request.image_path,
        request.filename,
        bool(request.image_base64),
        len(request.tags or []),
    )
    try:
        hydrus_config = _hydrus_config_from_runtime()
        return _upload_single_item(
            index=0,
            item=HydrusUploadImageListItem(
                image_path=request.image_path,
                image_base64=request.image_base64,
                filename=request.filename,
                tags=request.tags,
                extra_tags=request.extra_tags,
                source_urls=request.source_urls,
            ),
            model=request.model,
            general_threshold=request.general_threshold,
            character_threshold=request.character_threshold,
            hydrus_config=hydrus_config,
        )
    except HTTPException:
        logger.warning("Hydrus single upload failed with HTTPException image_path=%s filename=%s", request.image_path, request.filename, exc_info=True)
        raise
    except ValueError as exc:
        logger.warning("Hydrus single upload failed image_path=%s filename=%s detail=%s", request.image_path, request.filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Hydrus single upload crashed image_path=%s filename=%s", request.image_path, request.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/hydrus/upload/images", response_model=HydrusUploadImageListResponse)
def hydrus_upload_images(request: HydrusUploadImageListRequest) -> HydrusUploadImageListResponse:
    """上传图片列表到 Hydrus；每一项 tags 为空时自动打标并翻译。"""
    logger.info(
        "Hydrus batch upload requested total=%s model=%s general_threshold=%s character_threshold=%s",
        len(request.items),
        request.model,
        request.general_threshold,
        request.character_threshold,
    )
    if not request.items:
        logger.warning("Hydrus batch upload rejected because item list is empty")
        raise HTTPException(status_code=400, detail="No tagged images to upload")

    try:
        hydrus_config = _hydrus_config_from_runtime()
    except HTTPException:
        logger.warning("Hydrus batch upload failed because runtime Hydrus config is invalid", exc_info=True)
        raise
    items: list[HydrusUploadImageResult] = []

    for index, item in enumerate(request.items):
        try:
            items.append(
                _upload_single_item(
                    index=index,
                    item=item,
                    model=request.model,
                    general_threshold=request.general_threshold,
                    character_threshold=request.character_threshold,
                    hydrus_config=hydrus_config,
                )
            )
        except Exception as exc:
            logger.exception(
                "Hydrus batch upload item failed index=%s image_path=%s filename=%s",
                index,
                item.image_path,
                item.filename,
            )
            items.append(
                HydrusUploadImageResult(
                    index=index,
                    filename=item.filename,
                    image_path=item.image_path,
                    success=False,
                    hydrus_hash=None,
                    hydrus_status=None,
                    used_ai_tags=not bool(_normalize_tags(item.tags)),
                    english_tags=[],
                    translated_tags=[],
                    error=str(exc),
                )
            )

    succeeded = sum(1 for item in items if item.success)
    failed = len(items) - succeeded
    logger.info("Hydrus batch upload finished total=%s succeeded=%s failed=%s", len(items), succeeded, failed)
    return HydrusUploadImageListResponse(
        message=f"Uploaded {succeeded} of {len(items)} images to Hydrus.",
        total=len(items),
        succeeded=succeeded,
        failed=failed,
        items=items,
    )


@app.post("/api/v1/tags/upload", response_model=TagResponse)
async def tag_upload(
    file: UploadFile = File(...),
    model: str | None = Form(default=None),
    general_threshold: float | None = Form(default=None),
    character_threshold: float | None = Form(default=None),
) -> TagResponse:
    """处理单张图片的 multipart 上传打标请求。"""
    logger.info(
        "Tag upload requested filename=%s model=%s general_threshold=%s character_threshold=%s",
        file.filename,
        model,
        general_threshold,
        character_threshold,
    )
    payload = await file.read()
    _ensure_payload_size(payload)

    try:
        result = _with_translations(
            service.predict_bytes(
                image_bytes=payload,
                filename=file.filename,
                options=_prediction_options(model, general_threshold, character_threshold),
            )
        )
        logger.info(
            "Tag upload succeeded filename=%s model=%s hydrus_tag_count=%s translated_tag_count=%s",
            file.filename,
            result.model,
            len(result.hydrus_tags),
            len(result.translated_tags),
        )
        return result
    except HTTPException:
        logger.warning("Tag upload failed with HTTPException filename=%s", file.filename, exc_info=True)
        raise
    except ValueError as exc:
        logger.warning("Tag upload failed filename=%s detail=%s", file.filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Tag upload crashed filename=%s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v1/tags/upload/batch", response_model=BatchTagResponse)
async def tag_upload_batch(
    files: list[UploadFile] = File(...),
    model: str | None = Form(default=None),
    general_threshold: float | None = Form(default=None),
    character_threshold: float | None = Form(default=None),
) -> BatchTagResponse:
    """处理多张图片的批量上传打标请求。"""
    logger.info(
        "Tag batch upload requested file_count=%s model=%s general_threshold=%s character_threshold=%s",
        len(files),
        model,
        general_threshold,
        character_threshold,
    )
    options = _prediction_options(model, general_threshold, character_threshold)
    items: list[BatchTagItemResponse] = []

    try:
        for index, file in enumerate(files):
            logger.info("Tag batch item started index=%s filename=%s", index, file.filename)
            payload = await file.read()
            _ensure_payload_size(payload)
            result = _with_translations(
                service.predict_bytes(
                    image_bytes=payload,
                    filename=file.filename,
                    options=options,
                )
            )
            items.append(BatchTagItemResponse(index=index, **result.model_dump()))
            logger.info(
                "Tag batch item succeeded index=%s filename=%s hydrus_tag_count=%s translated_tag_count=%s",
                index,
                file.filename,
                len(result.hydrus_tags),
                len(result.translated_tags),
            )
    except HTTPException:
        logger.warning("Tag batch upload failed with HTTPException", exc_info=True)
        raise
    except ValueError as exc:
        logger.warning("Tag batch upload failed detail=%s", exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Tag batch upload crashed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    logger.info("Tag batch upload finished model=%s item_count=%s", options.model_name, len(items))
    return BatchTagResponse(model=options.model_name, items=items)


@app.post("/api/v1/tags/base64", response_model=TagResponse)
def tag_base64(request: Base64TagRequest) -> TagResponse:
    """处理 base64 图片打标请求。"""
    logger.info(
        "Tag base64 requested filename=%s model=%s general_threshold=%s character_threshold=%s has_base64=%s",
        request.filename,
        request.model,
        request.general_threshold,
        request.character_threshold,
        bool(request.image_base64),
    )
    try:
        payload = base64.b64decode(request.image_base64, validate=True)
        _ensure_payload_size(payload)
        result = _with_translations(
            service.predict_bytes(
                image_bytes=payload,
                filename=request.filename,
                options=_prediction_options(
                    request.model,
                    request.general_threshold,
                    request.character_threshold,
                ),
            )
        )
        logger.info(
            "Tag base64 succeeded filename=%s model=%s hydrus_tag_count=%s translated_tag_count=%s",
            request.filename,
            result.model,
            len(result.hydrus_tags),
            len(result.translated_tags),
        )
        return result
    except HTTPException:
        logger.warning("Tag base64 failed with HTTPException filename=%s", request.filename, exc_info=True)
        raise
    except binascii.Error as exc:
        logger.warning("Tag base64 failed because payload is invalid filename=%s", request.filename)
        raise HTTPException(status_code=400, detail="image_base64 is not valid base64") from exc
    except ValueError as exc:
        logger.warning("Tag base64 failed filename=%s detail=%s", request.filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Tag base64 crashed filename=%s", request.filename)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def run() -> None:
    """启动 Uvicorn 服务。"""
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
