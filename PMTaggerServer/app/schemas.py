"""集中定义服务输入输出使用的数据结构。"""

from __future__ import annotations

from typing import Any
from typing import Literal

from pydantic import BaseModel, Field


class TagPrediction(BaseModel):
    """普通标签或角色标签的结构化表示。"""

    category: Literal["general", "character"]
    name: str
    raw_name: str
    score: float
    hydrus_tag: str


class RatingPrediction(BaseModel):
    """图片评级标签的结构化表示。"""

    name: str
    raw_name: str
    score: float
    hydrus_tag: str


class TranslatedTag(BaseModel):
    """翻译后的标签信息，保留英文原文和命中状态。"""

    english_tag: str
    normalized_english_tag: str
    chinese_tag: str
    base_english_tag: str
    base_chinese_tag: str
    namespace: str | None = None
    found: bool


class TagResponse(BaseModel):
    """AI 打标接口返回的完整结果。"""

    filename: str | None = None
    model: str
    image_width: int
    image_height: int
    general_threshold: float
    character_threshold: float
    rating: RatingPrediction
    general: list[TagPrediction]
    character: list[TagPrediction]
    hydrus_tags: list[str]
    translated_tags: list[TranslatedTag] = Field(default_factory=list)


class BatchTagItemResponse(TagResponse):
    """批量打标时单张图片的响应结构。"""

    index: int = Field(..., ge=0)


class BatchTagResponse(BaseModel):
    """批量打标接口响应。"""

    model: str
    items: list[BatchTagItemResponse]


class Base64TagRequest(BaseModel):
    """base64 图片打标接口请求体。"""

    image_base64: str
    filename: str | None = None
    model: str | None = None
    general_threshold: float | None = None
    character_threshold: float | None = None


class ModelInfo(BaseModel):
    """模型列表接口中的单个模型描述。"""

    name: str
    repo_id: str
    loaded: bool


class ConfigResponse(BaseModel):
    """对外暴露的服务默认配置。"""

    default_model: str
    general_threshold: float
    character_threshold: float
    max_upload_bytes: int
    device: str
    translation_csv_path: str


class WarmupResponse(BaseModel):
    """模型预热接口响应。"""

    model: str
    loaded: bool
    device: str


class TagProcessRequest(BaseModel):
    """统一处理接口请求体。"""

    image_base64: str | None = None
    filename: str | None = None
    tags: list[str] | None = None
    model: str | None = None
    general_threshold: float | None = None
    character_threshold: float | None = None
    metadata: dict[str, Any] | None = None


class TagProcessResponse(BaseModel):
    """统一处理接口响应。"""

    filename: str | None = None
    metadata: dict[str, Any] | None = None
    source: Literal["provided_tags", "ai_generated_tags"]
    model: str | None = None
    english_tags: list[str]
    translated_tags: list[TranslatedTag]
    ai_result: TagResponse | None = None


class RuntimeConfigResponse(BaseModel):
    """Web UI 读取当前运行时配置时使用的响应体。"""

    default_model: str
    general_threshold: float
    character_threshold: float
    max_upload_bytes: int
    device: str
    translation_csv_path: str
    hydrus_api_base_url: str
    hydrus_access_key: str
    hydrus_tag_service_name: str
    available_models: list[str]


class RuntimeConfigUpdateRequest(BaseModel):
    """Web UI 修改运行时配置时使用的请求体。"""

    default_model: str | None = None
    general_threshold: float | None = None
    character_threshold: float | None = None
    translation_csv_path: str | None = None
    hydrus_api_base_url: str | None = None
    hydrus_access_key: str | None = None
    hydrus_tag_service_name: str | None = None


class ConnectionCheckResponse(BaseModel):
    """服务与 Hydrus 连接检测响应。"""

    service_available: bool
    device: str
    hydrus_available: bool
    hydrus_api_version: int | None = None
    hydrus_tag_service_name: str | None = None
    hydrus_tag_service_key: str | None = None
    hydrus_error: str | None = None


class HydrusUploadImageRequest(BaseModel):
    """上传单张图片到 Hydrus 的请求体。"""

    image_path: str | None = None
    image_base64: str | None = None
    filename: str | None = None
    tags: list[str] | None = None
    extra_tags: list[str] | None = None
    source_urls: list[str] | None = None
    model: str | None = None
    general_threshold: float | None = None
    character_threshold: float | None = None


class HydrusUploadImageListItem(BaseModel):
    """上传图片列表中的单个图片请求。"""

    image_path: str | None = None
    image_base64: str | None = None
    filename: str | None = None
    tags: list[str] | None = None
    extra_tags: list[str] | None = None
    source_urls: list[str] | None = None


class HydrusUploadImageResult(BaseModel):
    """上传到 Hydrus 的单张图片结果。"""

    index: int = Field(..., ge=0)
    filename: str | None = None
    image_path: str | None = None
    success: bool
    hydrus_hash: str | None = None
    hydrus_status: int | None = None
    used_ai_tags: bool
    english_tags: list[str] = Field(default_factory=list)
    translated_tags: list[TranslatedTag] = Field(default_factory=list)
    error: str | None = None


class HydrusUploadImageListRequest(BaseModel):
    """上传图片列表到 Hydrus 的请求体。"""

    items: list[HydrusUploadImageListItem]
    model: str | None = None
    general_threshold: float | None = None
    character_threshold: float | None = None


class HydrusUploadImageListResponse(BaseModel):
    """上传图片列表到 Hydrus 的响应。"""

    message: str
    total: int
    succeeded: int
    failed: int
    items: list[HydrusUploadImageResult]
