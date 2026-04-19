"""集中处理图片读取与模型输入前的预处理。"""

from __future__ import annotations

from io import BytesIO

from PIL import Image, UnidentifiedImageError


# 放宽 Pillow 对超大图片的保护上限，避免一些大图直接报错。
Image.MAX_IMAGE_PIXELS = 933120000


def pil_ensure_rgb(image: Image.Image) -> Image.Image:
    """把输入图片统一转换成无透明通道的 RGB 图像。"""
    if image.mode not in ["RGB", "RGBA"]:
        image = image.convert("RGBA") if "transparency" in image.info else image.convert("RGB")

    if image.mode == "RGBA":
        # 模型不处理透明通道，所以这里把透明区域合成到白底上。
        canvas = Image.new("RGBA", image.size, (255, 255, 255))
        canvas.alpha_composite(image)
        image = canvas.convert("RGB")

    return image


def pil_pad_square(image: Image.Image) -> Image.Image:
    """把长方形图片补成白底正方形，保持主体居中。"""
    w, h = image.size
    px = max(image.size)
    canvas = Image.new("RGB", (px, px), (255, 255, 255))
    canvas.paste(image, ((px - w) // 2, (px - h) // 2))
    return canvas


def read_image(image_bytes: bytes) -> tuple[Image.Image, int, int]:
    """从原始字节读取图片，并返回预处理后的图像和原始尺寸。"""
    try:
        with Image.open(BytesIO(image_bytes)) as opened:
            # 先强制加载到内存，避免后续在 with 作用域外访问已关闭文件句柄。
            opened.load()
            width, height = opened.size
            image = pil_ensure_rgb(opened)
            image = pil_pad_square(image)
    except UnidentifiedImageError as exc:
        raise ValueError("Uploaded file is not a supported image") from exc

    return image, width, height
