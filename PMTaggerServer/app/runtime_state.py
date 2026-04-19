"""管理 Web UI 可动态修改的运行时配置。"""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path
import re
from threading import RLock
import time

from app.config import MODEL_REPO_MAP, Settings
from app.model_service import PredictionOptions
from app.schemas import RuntimeConfigResponse, RuntimeConfigUpdateRequest
from app.translation_service import TagTranslationService

logger = logging.getLogger("hydrus_uploader_tagger.runtime_state")


@dataclass
class RuntimeConfig:
    """保存运行时可修改的配置项。"""

    default_model: str
    general_threshold: float
    character_threshold: float
    translation_csv_path: Path
    hydrus_api_base_url: str
    hydrus_access_key: str
    hydrus_tag_service_name: str


class AppRuntimeState:
    """封装 UI 运行时状态，并负责热更新翻译服务。"""

    def __init__(self, settings: Settings) -> None:
        """用启动配置初始化运行时状态。"""
        self._settings = settings
        self._lock = RLock()
        self._runtime_root_dir = Path(__file__).resolve().parents[1]
        self._runtime_config_path = self._runtime_root_dir / "runtime-config.json"
        self._config = RuntimeConfig(
            default_model=settings.default_model,
            general_threshold=settings.general_threshold,
            character_threshold=settings.character_threshold,
            translation_csv_path=settings.translation_csv_path,
            hydrus_api_base_url=settings.hydrus_api_base_url,
            hydrus_access_key=settings.hydrus_access_key,
            hydrus_tag_service_name=settings.hydrus_tag_service_name,
        )
        self._translator = TagTranslationService(settings.translation_csv_path)
        self._runtime_translation_dir = self._runtime_root_dir / ".runtime_translation_csv"
        self._runtime_translation_dir.mkdir(parents=True, exist_ok=True)
        self._load_persisted_runtime_config()

    def get_translator(self) -> TagTranslationService:
        """返回当前运行时正在使用的翻译服务实例。"""
        return self._translator

    def get_runtime_config(self, *, device_name: str) -> RuntimeConfigResponse:
        """读取当前运行时配置，并补充设备和模型列表信息。"""
        with self._lock:
            return RuntimeConfigResponse(
                default_model=self._config.default_model,
                general_threshold=self._config.general_threshold,
                character_threshold=self._config.character_threshold,
                max_upload_bytes=self._settings.max_upload_bytes,
                device=device_name,
                translation_csv_path=str(self._config.translation_csv_path),
                hydrus_api_base_url=self._config.hydrus_api_base_url,
                hydrus_access_key=self._config.hydrus_access_key,
                hydrus_tag_service_name=self._config.hydrus_tag_service_name,
                available_models=list(MODEL_REPO_MAP),
            )

    def update_runtime_config(
        self,
        request: RuntimeConfigUpdateRequest,
        *,
        device_name: str,
    ) -> RuntimeConfigResponse:
        """更新运行时配置，并在必要时重新加载翻译词表。"""
        with self._lock:
            if request.default_model is not None:
                self._validate_model(request.default_model)
                self._config.default_model = request.default_model

            if request.general_threshold is not None:
                self._validate_threshold("general_threshold", request.general_threshold)
                self._config.general_threshold = request.general_threshold

            if request.character_threshold is not None:
                self._validate_threshold("character_threshold", request.character_threshold)
                self._config.character_threshold = request.character_threshold

            if request.hydrus_api_base_url is not None:
                self._config.hydrus_api_base_url = request.hydrus_api_base_url.strip()

            if request.hydrus_access_key is not None:
                self._config.hydrus_access_key = request.hydrus_access_key.strip()

            if request.hydrus_tag_service_name is not None:
                self._config.hydrus_tag_service_name = request.hydrus_tag_service_name.strip()

            if request.translation_csv_path is not None:
                csv_path = Path(request.translation_csv_path).expanduser().resolve()
                if not csv_path.is_file():
                    raise ValueError(f"Translation CSV does not exist: {csv_path}")
                self._config.translation_csv_path = csv_path
                # 翻译词表切换后要同步替换内存中的翻译服务实例。
                self._translator = TagTranslationService(csv_path)

            self._save_runtime_config()
            return self.get_runtime_config(device_name=device_name)

    def update_translation_csv_upload(
        self,
        csv_bytes: bytes,
        filename: str | None,
        *,
        device_name: str,
    ) -> RuntimeConfigResponse:
        """把前端上传的 CSV 保存到运行时目录，并立即替换当前翻译服务。"""
        with self._lock:
            stored_path = self._store_translation_csv(csv_bytes, filename)
            self._translator = TagTranslationService(stored_path)
            self._config.translation_csv_path = stored_path
            self._save_runtime_config()
            return self.get_runtime_config(device_name=device_name)

    def build_prediction_options(
        self,
        model: str | None,
        general_threshold: float | None,
        character_threshold: float | None,
    ) -> PredictionOptions:
        """按“请求参数优先、运行时配置兜底”的规则生成推理选项。"""
        with self._lock:
            resolved_model = model or self._config.default_model
            resolved_general_threshold = (
                general_threshold
                if general_threshold is not None
                else self._config.general_threshold
            )
            resolved_character_threshold = (
                character_threshold
                if character_threshold is not None
                else self._config.character_threshold
            )

        self._validate_model(resolved_model)
        self._validate_threshold("general_threshold", resolved_general_threshold)
        self._validate_threshold("character_threshold", resolved_character_threshold)

        return PredictionOptions(
            model_name=resolved_model,
            general_threshold=resolved_general_threshold,
            character_threshold=resolved_character_threshold,
        )

    @staticmethod
    def _validate_model(model_name: str) -> None:
        """校验模型短名是否合法。"""
        if model_name not in MODEL_REPO_MAP:
            raise ValueError(
                f"Unknown model '{model_name}', available models: {list(MODEL_REPO_MAP)}"
            )

    @staticmethod
    def _validate_threshold(name: str, value: float) -> None:
        """校验阈值必须落在 0 到 1 之间。"""
        if not 0 <= value <= 1:
            raise ValueError(f"{name} must be between 0 and 1")

    def _store_translation_csv(self, csv_bytes: bytes, filename: str | None) -> Path:
        """将上传的翻译 CSV 落盘到运行时目录，便于后续稳定复用。"""
        if not csv_bytes:
            raise ValueError("Translation CSV is empty")

        original_name = (filename or "translations.csv").strip() or "translations.csv"
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(original_name).name)
        if not safe_name.lower().endswith(".csv"):
            safe_name = f"{safe_name}.csv"

        target_path = self._runtime_translation_dir / f"{int(time.time() * 1000)}_{safe_name}"
        target_path.write_bytes(csv_bytes)
        return target_path

    def _load_persisted_runtime_config(self) -> None:
        """启动时读取本地 runtime-config.json，恢复上次保存的运行时配置。"""
        if not self._runtime_config_path.is_file():
            logger.info("Runtime config file does not exist, using defaults path=%s", self._runtime_config_path)
            return

        try:
            payload = json.loads(self._runtime_config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.exception("Runtime config file is invalid JSON path=%s", self._runtime_config_path)
            return
        except OSError:
            logger.exception("Failed to read runtime config file path=%s", self._runtime_config_path)
            return

        if not isinstance(payload, dict):
            logger.warning("Runtime config file root is not an object path=%s", self._runtime_config_path)
            return

        try:
            self._apply_persisted_payload(payload)
            logger.info("Runtime config restored from disk path=%s", self._runtime_config_path)
        except ValueError:
            logger.exception("Runtime config file contains invalid values path=%s", self._runtime_config_path)

    def _apply_persisted_payload(self, payload: dict[str, object]) -> None:
        """把磁盘中的 JSON 配置应用到当前内存状态。"""
        default_model = payload.get("default_model")
        if isinstance(default_model, str) and default_model.strip():
            self._validate_model(default_model)
            self._config.default_model = default_model

        general_threshold = payload.get("general_threshold")
        if isinstance(general_threshold, (int, float)):
            self._validate_threshold("general_threshold", float(general_threshold))
            self._config.general_threshold = float(general_threshold)

        character_threshold = payload.get("character_threshold")
        if isinstance(character_threshold, (int, float)):
            self._validate_threshold("character_threshold", float(character_threshold))
            self._config.character_threshold = float(character_threshold)

        hydrus_api_base_url = payload.get("hydrus_api_base_url")
        if isinstance(hydrus_api_base_url, str):
            self._config.hydrus_api_base_url = hydrus_api_base_url.strip()

        hydrus_access_key = payload.get("hydrus_access_key")
        if isinstance(hydrus_access_key, str):
            self._config.hydrus_access_key = hydrus_access_key.strip()

        hydrus_tag_service_name = payload.get("hydrus_tag_service_name")
        if isinstance(hydrus_tag_service_name, str):
            self._config.hydrus_tag_service_name = hydrus_tag_service_name.strip()

        translation_csv_path = payload.get("translation_csv_path")
        if isinstance(translation_csv_path, str) and translation_csv_path.strip():
            csv_path = Path(translation_csv_path).expanduser().resolve()
            if not csv_path.is_file():
                raise ValueError(f"Persisted translation CSV does not exist: {csv_path}")
            self._config.translation_csv_path = csv_path
            self._translator = TagTranslationService(csv_path)

    def _save_runtime_config(self) -> None:
        """把当前运行时配置写入本地 JSON，供浏览器刷新和服务重启后恢复。"""
        payload = {
            "default_model": self._config.default_model,
            "general_threshold": self._config.general_threshold,
            "character_threshold": self._config.character_threshold,
            "translation_csv_path": str(self._config.translation_csv_path),
            "hydrus_api_base_url": self._config.hydrus_api_base_url,
            "hydrus_access_key": self._config.hydrus_access_key,
            "hydrus_tag_service_name": self._config.hydrus_tag_service_name,
        }

        try:
            self._runtime_config_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            logger.info("Runtime config saved to disk path=%s", self._runtime_config_path)
        except OSError:
            logger.exception("Failed to write runtime config file path=%s", self._runtime_config_path)
            raise ValueError(f"Failed to write runtime config file: {self._runtime_config_path}")
