"""读取启动配置并对基础环境变量做校验。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


# 将对外暴露的模型短名映射到对应的 Hugging Face 仓库。
MODEL_REPO_MAP = {
    "vit": "SmilingWolf/wd-vit-tagger-v3",
    "vit-large": "SmilingWolf/wd-vit-large-tagger-v3",
    "swinv2": "SmilingWolf/wd-swinv2-tagger-v3",
    "convnext": "SmilingWolf/wd-convnext-tagger-v3",
}


def _read_float(name: str, default: float) -> float:
    """从环境变量读取浮点数，未设置时回退到默认值。"""
    value = os.getenv(name)
    if value is None:
        return default
    return float(value)


def _read_int(name: str, default: int) -> int:
    """从环境变量读取整数，未设置时回退到默认值。"""
    value = os.getenv(name)
    if value is None:
        return default
    return int(value)


@dataclass(frozen=True)
class Settings:
    """保存服务启动阶段使用的静态配置。"""

    host: str = os.getenv("TAGGER_HOST", "127.0.0.1")
    port: int = _read_int("TAGGER_PORT", 8000)
    default_model: str = os.getenv("TAGGER_MODEL", "vit")
    general_threshold: float = _read_float("TAGGER_GENERAL_THRESHOLD", 0.35)
    character_threshold: float = _read_float("TAGGER_CHARACTER_THRESHOLD", 0.75)
    max_upload_bytes: int = _read_int("TAGGER_MAX_UPLOAD_BYTES", 25 * 1024 * 1024)
    hydrus_api_base_url: str = os.getenv("HYDRUS_API_BASE_URL", "http://127.0.0.1:45869")
    hydrus_access_key: str = os.getenv("HYDRUS_ACCESS_KEY", "")
    hydrus_tag_service_name: str = os.getenv("HYDRUS_TAG_SERVICE_NAME", "PMTagger")
    translation_csv_path: Path = Path(
        os.getenv(
            "TAGGER_TRANSLATIONS_CSV",
            str(Path(__file__).resolve().parents[2] / "translations.csv"),
        )
    )

    def validate(self) -> "Settings":
        """校验配置合法性，并返回自身以便链式调用。"""
        if self.default_model not in MODEL_REPO_MAP:
            raise ValueError(
                f"Unsupported default model '{self.default_model}', "
                f"available models: {list(MODEL_REPO_MAP)}"
            )
        if self.port <= 0:
            raise ValueError("TAGGER_PORT must be positive")
        if self.max_upload_bytes <= 0:
            raise ValueError("TAGGER_MAX_UPLOAD_BYTES must be positive")
        if not self.translation_csv_path.is_file():
            raise ValueError(
                f"TAGGER_TRANSLATIONS_CSV does not exist: {self.translation_csv_path}"
            )
        return self


def get_settings() -> Settings:
    """构造并返回已经校验过的启动配置。"""
    return Settings().validate()
