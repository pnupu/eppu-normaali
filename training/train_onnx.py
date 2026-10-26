#!/usr/bin/env python3
"""Run the pinned openWakeWord trainer with Eppu's ONNX/macOS adjustments.

Keep the upstream checkout untouched. Its optional TFLite conversion needs a
separate TensorFlow toolchain, and its lambda-based dataset cannot be pickled
by macOS spawn workers. Feature sizing includes every augmentation round.
Other training errors still propagate normally.
"""
import ast
from pathlib import Path
import sys


class OnnxTrainer(ast.NodeTransformer):
    def __init__(self, single_process: bool):
        self.single_process = single_process
        self.conversions = 0
        self.loaders = 0
        self.feature_writers = 0

    def visit_Call(self, node):
        self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id == "convert_onnx_to_tflite":
            self.conversions += 1
            return ast.copy_location(ast.Call(
                func=ast.Name(id="print", ctx=ast.Load()),
                args=[ast.Constant(value="ONNX exported; skipping optional TFLite conversion.")],
                keywords=[],
            ), node)
        if isinstance(node.func, ast.Name) and node.func.id == "compute_features_from_generator":
            for keyword in node.keywords:
                if keyword.arg == "n_total":
                    self.feature_writers += 1
                    keyword.value = ast.BinOp(
                        left=keyword.value, op=ast.Mult(),
                        right=ast.Subscript(value=ast.Name(id="config", ctx=ast.Load()),
                                            slice=ast.Constant(value="augmentation_rounds"), ctx=ast.Load()),
                    )
        if ast.unparse(node.func) == "torch.utils.data.DataLoader" and any(
            keyword.arg == "prefetch_factor" for keyword in node.keywords
        ):
            self.loaders += 1
            if self.single_process:
                node.keywords = [keyword for keyword in node.keywords
                                 if keyword.arg not in ("num_workers", "prefetch_factor")]
                node.keywords.append(ast.keyword(arg="num_workers", value=ast.Constant(value=0)))
        return node


def prepare_trainer(source: str, filename: str, single_process: bool):
    transformer = OnnxTrainer(single_process)
    tree = transformer.visit(ast.parse(source, filename))
    if transformer.conversions != 1 or transformer.loaders != 1 or transformer.feature_writers != 4:
        raise RuntimeError("Unexpected upstream trainer; rerun setup.sh to restore the pinned version")
    return compile(ast.fix_missing_locations(tree), filename, "exec")


def main() -> None:
    upstream = Path(__file__).resolve().parent / "work/openwakeword/openwakeword/train.py"
    code = prepare_trainer(upstream.read_text(), str(upstream), single_process=sys.platform == "darwin")
    sys.argv[0] = str(upstream)
    sys.path.insert(0, str(upstream.parent))
    exec(code, {"__name__": "__main__", "__file__": str(upstream)})


if __name__ == "__main__":
    main()
