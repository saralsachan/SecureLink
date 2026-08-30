from __future__ import annotations

import argparse
import tempfile
from collections.abc import Sequence
from pathlib import Path

import onnx
import requests
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForImageClassification


DEFAULT_MOBILEVIT_MODEL_ID = "apple/mobilevit-xx-small"
DEFAULT_YUNET_URLS = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/"
    "face_detection_yunet_2023mar.onnx",
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
    "face_detection_yunet_2023mar.onnx",
)


def file_size_mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024)


def export_mobilevit_to_onnx(
    model_id: str,
    output_path: Path,
    image_size: int,
    opset: int,
) -> None:
    print(f"Downloading MobileViT model from Hugging Face: {model_id}")
    model = AutoModelForImageClassification.from_pretrained(model_id)
    model.eval()

    dummy_input = torch.randn(1, 3, image_size, image_size, dtype=torch.float32)

    with tempfile.TemporaryDirectory() as temp_dir:
        fp32_path = Path(temp_dir) / "mobilevit_xxs_fp32.onnx"

        print(f"Exporting MobileViT FP32 ONNX with dynamic axes: {fp32_path}")
        torch.onnx.export(
            model,
            (dummy_input,),
            fp32_path,
            input_names=["pixel_values"],
            output_names=["logits"],
            dynamic_axes={
                "pixel_values": {
                    0: "batch",
                    2: "height",
                    3: "width",
                },
                "logits": {
                    0: "batch",
                },
            },
            opset_version=opset,
            do_constant_folding=True,
            dynamo=False,
        )

        print("Validating exported MobileViT FP32 ONNX.")
        onnx.checker.check_model(onnx.load(fp32_path))

        print(f"Quantizing MobileViT to INT8: {output_path}")
        quantize_dynamic(
            model_input=fp32_path,
            model_output=output_path,
            weight_type=QuantType.QInt8,
        )

    print("Validating quantized MobileViT ONNX.")
    onnx.checker.check_model(onnx.load(output_path))


def download_yunet(output_path: Path, urls: Sequence[str]) -> None:
    last_error: Exception | None = None
    for url in urls:
        print(f"Downloading YuNet face detector ONNX: {url}")
        try:
            response = requests.get(url, timeout=120)
            response.raise_for_status()
            output_path.write_bytes(response.content)

            print("Validating YuNet ONNX.")
            onnx.checker.check_model(onnx.load(output_path))
            return
        except requests.RequestException as exc:
            last_error = exc
            print(f"  Failed (trying next source): {exc}")
    raise RuntimeError(f"Could not download YuNet from any source: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Export MobileViT-XXS to dynamic-shape ONNX, quantize it to INT8, "
            "and download YuNet face detection ONNX for the browser extension."
        )
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MOBILEVIT_MODEL_ID,
        help="Hugging Face model id for MobileViT-XXS.",
    )
    parser.add_argument(
        "--yunet-url",
        action="append",
        default=list(DEFAULT_YUNET_URLS),
        help=(
            "Source URL(s) for the YuNet ONNX model (tried in order). "
            "Repeat the flag to add more mirrors; defaults to GitHub opencv_zoo "
            "then the Hugging Face opencv/face_detection_yunet mirror."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "extension" / "models",
        help="Directory where ONNX files will be written.",
    )
    parser.add_argument(
        "--image-size",
        type=int,
        default=256,
        help="Example export size. Height and width remain dynamic in the ONNX graph.",
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset version for export.",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    mobilevit_path = args.output_dir / "mobilevit_xxs_int8.onnx"
    yunet_path = args.output_dir / "yunet_face_detection.onnx"

    export_mobilevit_to_onnx(
        model_id=args.model_id,
        output_path=mobilevit_path,
        image_size=args.image_size,
        opset=args.opset,
    )
    download_yunet(output_path=yunet_path, urls=args.yunet_url)

    print("\nExported browser models:")
    for path in (mobilevit_path, yunet_path):
        print(f"- {path}: {file_size_mb(path):.2f} MB")


if __name__ == "__main__":
    main()

