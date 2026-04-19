"""封装 WD Tagger 模型加载、推理和标签整理流程。"""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Any

import numpy as np
import pandas as pd
import timm
import torch
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import HfHubHTTPError
from PIL import Image
from timm.data.config import resolve_data_config
from timm.data.transforms_factory import create_transform
from torch import Tensor
from torch.nn import Module, functional as F
from torchvision.transforms.transforms import Compose

from app.config import MODEL_REPO_MAP, Settings
from app.image_utils import read_image
from app.schemas import RatingPrediction, TagPrediction, TagResponse


@dataclass
class LabelData:
    """保存模型标签表及其分类索引。"""

    names: list[str]
    rating: list[np.int64]
    general: list[np.int64]
    character: list[np.int64]


@dataclass
class ModelBundle:
    """保存单个模型推理所需的全部资源。"""

    repo_id: str
    model: Module
    transform: Compose
    labels: LabelData


@dataclass
class PredictionOptions:
    """保存一次推理请求使用的模型和阈值参数。"""

    model_name: str
    general_threshold: float
    character_threshold: float


def _display_name(raw_name: str) -> str:
    """把模型标签中的下划线格式转换成人类可读的显示格式。"""
    return raw_name.replace("_", " ")


def _build_tag(raw_name: str, score: float, category: str) -> TagPrediction:
    """把原始模型输出包装成普通标签或角色标签对象。"""
    return TagPrediction(
        category=category,
        name=_display_name(raw_name),
        raw_name=raw_name,
        score=float(score),
        hydrus_tag=(
            _display_name(raw_name)
            if category == "general"
            else f"character:{_display_name(raw_name)}"
        ),
    )


def _build_rating(raw_name: str, score: float) -> RatingPrediction:
    """把模型的 rating 输出包装成统一响应结构。"""
    display = _display_name(raw_name)
    return RatingPrediction(
        name=display,
        raw_name=raw_name,
        score=float(score),
        hydrus_tag=f"rating:{display}",
    )


def load_labels_hf(repo_id: str) -> LabelData:
    """从 Hugging Face 下载 selected_tags.csv 并解析标签索引。"""
    try:
        csv_path = hf_hub_download(repo_id=repo_id, filename="selected_tags.csv")
    except HfHubHTTPError as exc:
        raise FileNotFoundError(f"selected_tags.csv failed to download from {repo_id}") from exc

    df: pd.DataFrame = pd.read_csv(csv_path, usecols=["name", "category"])
    return LabelData(
        names=df["name"].tolist(),
        rating=list(np.where(df["category"] == 9)[0]),
        general=list(np.where(df["category"] == 0)[0]),
        character=list(np.where(df["category"] == 4)[0]),
    )


class TaggerModelService:
    """负责模型缓存、图片推理和结果整理。"""

    def __init__(self, settings: Settings) -> None:
        """初始化推理服务并选择当前运行设备。"""
        self._settings = settings
        self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._lock = Lock()
        self._models: dict[str, ModelBundle] = {}

    @property
    def device_name(self) -> str:
        """返回当前推理设备名称。"""
        return self._device.type

    def get_loaded_status(self) -> dict[str, bool]:
        """返回各模型是否已被加载到内存。"""
        return {name: name in self._models for name in MODEL_REPO_MAP}

    def warmup(self, model_name: str | None = None) -> None:
        """手动预热模型，提前触发下载和加载。"""
        self._get_model_bundle(model_name or self._settings.default_model)

    def predict_bytes(
        self,
        image_bytes: bytes,
        filename: str | None,
        options: PredictionOptions,
    ) -> TagResponse:
        """对单张图片字节执行完整的预测流程。"""
        if not image_bytes:
            raise ValueError("Image payload is empty")

        # 图片预处理、模型推理、标签筛选在这里串成完整链路。
        image, width, height = read_image(image_bytes)
        bundle = self._get_model_bundle(options.model_name)
        outputs = self._run_inference(bundle, image)
        rating, general, character, hydrus_tags = self._extract_predictions(
            outputs=outputs,
            labels=bundle.labels,
            general_threshold=options.general_threshold,
            character_threshold=options.character_threshold,
        )

        return TagResponse(
            filename=filename,
            model=options.model_name,
            image_width=width,
            image_height=height,
            general_threshold=options.general_threshold,
            character_threshold=options.character_threshold,
            rating=rating,
            general=general,
            character=character,
            hydrus_tags=hydrus_tags,
        )

    def _get_model_bundle(self, model_name: str) -> ModelBundle:
        """获取指定模型的缓存资源，必要时执行懒加载。"""
        if model_name not in MODEL_REPO_MAP:
            raise ValueError(
                f"Unknown model '{model_name}', available models: {list(MODEL_REPO_MAP)}"
            )

        cached = self._models.get(model_name)
        if cached is not None:
            return cached

        with self._lock:
            cached = self._models.get(model_name)
            if cached is not None:
                return cached

            repo_id = MODEL_REPO_MAP[model_name]
            # 首次访问某模型时，按需从 Hugging Face 拉取权重并构建预处理流程。
            model = timm.create_model("hf-hub:" + repo_id).eval()
            model = model.to(device=self._device)
            state_dict = timm.models.load_state_dict_from_hf(repo_id)
            model.load_state_dict(state_dict)

            labels = load_labels_hf(repo_id)
            transform = create_transform(**resolve_data_config(model.pretrained_cfg, model=model))
            if not isinstance(transform, Compose):
                raise TypeError("Expected timm transform pipeline to be torchvision Compose")

            bundle = ModelBundle(
                repo_id=repo_id,
                model=model,
                transform=transform,
                labels=labels,
            )
            self._models[model_name] = bundle
            return bundle

    @torch.inference_mode()
    def _run_inference(self, bundle: ModelBundle, image: Image.Image) -> Tensor:
        """执行单张图片推理并返回 sigmoid 后的概率向量。"""
        inputs: Tensor = bundle.transform(image).unsqueeze(0)
        # WD Tagger 的 timm 版本期望 BGR 通道顺序。
        inputs = inputs[:, [2, 1, 0]].to(device=self._device)

        outputs = bundle.model.forward(inputs)
        outputs = F.sigmoid(outputs)

        if self._device.type != "cpu":
            outputs = outputs.to("cpu")

        return outputs.squeeze(0)

    def _extract_predictions(
        self,
        outputs: Tensor,
        labels: LabelData,
        general_threshold: float,
        character_threshold: float,
    ) -> tuple[RatingPrediction, list[TagPrediction], list[TagPrediction], list[str]]:
        """按标签类别和阈值把概率向量转换成最终响应结构。"""
        probs: list[tuple[str, Any]] = list(zip(labels.names, outputs.numpy()))

        rating_candidates = [probs[i] for i in labels.rating]
        rating_name, rating_score = max(rating_candidates, key=lambda item: item[1])
        rating = _build_rating(str(rating_name), float(rating_score))

        # 普通标签与角色标签分别使用不同阈值筛选。
        general = [
            _build_tag(str(name), float(score), "general")
            for name, score in (probs[i] for i in labels.general)
            if float(score) > general_threshold
        ]
        general.sort(key=lambda item: item.score, reverse=True)

        character = [
            _build_tag(str(name), float(score), "character")
            for name, score in (probs[i] for i in labels.character)
            if float(score) > character_threshold
        ]
        character.sort(key=lambda item: item.score, reverse=True)

        hydrus_tags = [item.hydrus_tag for item in general]
        hydrus_tags.extend(item.hydrus_tag for item in character)
        hydrus_tags.append(rating.hydrus_tag)

        return rating, general, character, hydrus_tags
