"""从本地 translations.csv 读取标签翻译并提供查询能力。"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from app.schemas import TranslatedTag


# 只把这些命名空间视为“命名空间:标签”的结构，其余内容按普通标签处理。
SUPPORTED_NAMESPACES = {"character", "rating"}


@dataclass(frozen=True)
class TranslationRecord:
    """表示词表中的一条翻译记录。"""

    english_tag: str
    chinese_tag: str


def _normalize_tag(tag: str) -> str:
    """把标签统一成词表查询使用的标准格式。"""
    return tag.strip().replace(" ", "_").lower()


def _split_namespace(tag: str) -> tuple[str | None, str]:
    """拆分命名空间标签，例如 character:hatsune miku。"""
    if ":" not in tag:
        return None, tag.strip()

    namespace, raw_tag = tag.split(":", 1)
    namespace = namespace.strip().lower()
    if namespace not in SUPPORTED_NAMESPACES:
        return None, tag.strip()
    return namespace, raw_tag.strip()


class TagTranslationService:
    """负责加载翻译词表并执行英文标签到中文标签的映射。"""

    def __init__(self, csv_path: Path) -> None:
        """初始化翻译服务并在启动时把词表载入内存。"""
        self._csv_path = csv_path
        self._records = self._load_csv(csv_path)

    @property
    def csv_path(self) -> Path:
        """返回当前正在使用的翻译词表路径。"""
        return self._csv_path

    @property
    def total_records(self) -> int:
        """返回当前词表总记录数。"""
        return len(self._records)

    def translate_tags(self, tags: list[str]) -> list[TranslatedTag]:
        """批量翻译标签列表。"""
        return [self.translate_tag(tag) for tag in tags]

    def translate_tag(self, tag: str) -> TranslatedTag:
        """翻译单个标签，并保留命名空间信息。"""
        namespace, base_english_tag = _split_namespace(tag)
        normalized_base_tag = _normalize_tag(base_english_tag)
        record = self._records.get(normalized_base_tag)
        base_chinese_tag = (
            record.chinese_tag
            if record is not None
            else base_english_tag.replace("_", " ")
        )
        chinese_tag = (
            f"{namespace}:{base_chinese_tag}"
            if namespace is not None
            else base_chinese_tag
        )

        return TranslatedTag(
            english_tag=tag,
            normalized_english_tag=(
                f"{namespace}:{normalized_base_tag}"
                if namespace is not None
                else normalized_base_tag
            ),
            chinese_tag=chinese_tag,
            base_english_tag=base_english_tag,
            base_chinese_tag=base_chinese_tag,
            namespace=namespace,
            found=record is not None,
        )

    def _load_csv(self, csv_path: Path) -> dict[str, TranslationRecord]:
        """读取 CSV 词表并构造成内存索引。"""
        records: dict[str, TranslationRecord] = {}
        with csv_path.open("r", encoding="utf-8-sig", newline="") as file:
            reader = csv.reader(file)
            for row in reader:
                if len(row) < 3:
                    continue
                english_tag = row[0].strip()
                chinese_tag = row[2].strip()
                if not english_tag or not chinese_tag:
                    continue

                # 词表里可能有多个中文候选，这里只取第一个变体作为默认翻译。
                records[_normalize_tag(english_tag)] = TranslationRecord(
                    english_tag=english_tag,
                    chinese_tag=chinese_tag.split("|", 1)[0].strip(),
                )
        return records
