"""Small regression tests that do not download models or run training."""
import importlib.util
import itertools
from pathlib import Path
import sys
import shutil
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TrainingTests(unittest.TestCase):
    def test_split_stays_stable_and_removes_old_duplicate(self):
        mix = load("mix_real_samples")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            train, test = root / "train", root / "test"
            files = []
            for index in range(10):
                source = root / f"sample-{index}.wav"
                source.write_bytes(b"sample")
                files.append(source)
            mix.distribute(files, train, test, 0.2)
            original = {p.name: p.parent.name for folder in (train, test) for p in folder.iterdir()}
            # Simulate a previous shuffle having left the same sample in both sets.
            for folder in (train, test):
                (folder / "real_sample-0.wav").write_bytes(b"old")
            extra = root / "added.wav"
            extra.write_bytes(b"new")
            mix.distribute(files + [extra], train, test, 0.2)
            train_names = {p.name for p in train.iterdir()}
            test_names = {p.name for p in test.iterdir()}
            self.assertFalse(train_names & test_names)
            for name, folder in original.items():
                self.assertTrue((root / folder / name).exists())

    def test_verifier_selects_framework_for_model_extension(self):
        verifier = load("train_verifier")
        for extension, framework in (("onnx", "onnx"), ("tflite", "tflite")):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for index in range(3):
                    (root / f"{index}.wav").touch()
                calls = []
                stub = types.SimpleNamespace(train_custom_verifier=lambda **kwargs: calls.append(kwargs))
                args = ["train_verifier.py", "--positive-dir", directory, "--negative-dir", directory,
                        "--model", str(root / f"wake.{extension}")]
                with patch.dict(sys.modules, {"openwakeword": stub}), patch.object(sys, "argv", args):
                    self.assertEqual(verifier.main(), 0)
                self.assertEqual(calls[0]["inference_framework"], framework)

    def test_onnx_runner_skips_conversion_and_fixes_mac_loader(self):
        runner = load("train_onnx")
        source = """
from types import SimpleNamespace
calls = []
feature_sizes = []
config = {"augmentation_rounds": 2}
def compute_features_from_generator(*args, **kwargs):
    feature_sizes.append(kwargs["n_total"])
compute_features_from_generator('positive_train', n_total=4)
compute_features_from_generator('negative_train', n_total=4)
compute_features_from_generator('positive_test', n_total=4)
compute_features_from_generator('negative_test', n_total=4)
def loader(*args, **kwargs):
    calls.append(kwargs)
torch = SimpleNamespace(utils=SimpleNamespace(data=SimpleNamespace(DataLoader=loader)))
def convert_onnx_to_tflite(*args):
    raise AssertionError('TFLite must not run')
torch.utils.data.DataLoader('dataset', num_workers=8, prefetch_factor=16)
convert_onnx_to_tflite('wake.onnx', 'wake.tflite')
"""
        for single_process in (False, True):
            namespace = {}
            exec(runner.prepare_trainer(source, "trainer.py", single_process), namespace)
            expected = {"num_workers": 0} if single_process else {"num_workers": 8, "prefetch_factor": 16}
            self.assertEqual(namespace["calls"], [expected])
            self.assertEqual(namespace["feature_sizes"], [8, 8, 8, 8])
        with self.assertRaisesRegex(RuntimeError, "training failed"):
            exec(runner.prepare_trainer(source + "\nraise RuntimeError('training failed')", "trainer.py", True), {})
        with self.assertRaisesRegex(RuntimeError, "Unexpected upstream"):
            runner.prepare_trainer("print('incompatible trainer')", "trainer.py", True)

    def test_resuming_validation_generation_preserves_existing_clips(self):
        def generator(text, output_dir, model, max_samples=None, file_names=None, **kwargs):
            # Naming behavior of the pinned Piper generator, with inference omitted.
            names = itertools.cycle(file_names) if file_names else None
            for index in range(max_samples):
                name = next(names) if names else f"{index}.wav"
                (Path(output_dir) / name).write_bytes(b"new clip")

        stub = types.SimpleNamespace(generate_samples=generator)
        with patch.dict(sys.modules, {"piper_sample_generator.__main__": stub}):
            shim = load("shim/generate_samples")
        with patch.object(shim, "_resample_dir_to_16k", lambda _: None):
            for split in ("positive_test", "negative_test"):
                with self.subTest(split=split), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    for index in range(2):
                        (root / f"{index}.wav").write_bytes(b"original clip")
                    shim.generate_samples(text="hey eppu", output_dir=directory, max_samples=2)
                    self.assertEqual(len(list(root.glob("*.wav"))), 4)
                    self.assertEqual((root / "0.wav").read_bytes(), b"original clip")
                    self.assertEqual((root / "1.wav").read_bytes(), b"original clip")
                    shim.generate_samples(text="hey eppu", output_dir=directory, max_samples=2)
                    self.assertEqual(len(list(root.glob("*.wav"))), 6)
                    shim.generate_samples(text="hey eppu", output_dir=directory, max_samples=1,
                                          file_names=["explicit.wav"])
                    self.assertTrue((root / "explicit.wav").exists())

    def test_partial_corpora_are_retried_and_only_completed_downloads_are_skipped(self):
        download = load("download_data")
        class Samples:
            def __mul__(self, value): return self
            def astype(self, dtype): return b"audio"
        numpy = types.SimpleNamespace(asarray=lambda _: Samples(), int16="int16")
        wavfile = types.SimpleNamespace(write=lambda filename, rate, data: Path(filename).write_bytes(data))
        scipy_io = types.SimpleNamespace(wavfile=wavfile)
        scipy = types.SimpleNamespace(io=scipy_io)
        modules = {"numpy": numpy, "scipy": scipy, "scipy.io": scipy_io,
                   "scipy.io.wavfile": wavfile, "tqdm": types.SimpleNamespace(tqdm=lambda rows: rows)}
        for function, folder, marker, size in (
            (download.download_rirs, "mit_rirs", ".mit_rirs.complete", 2),
            (download.download_noise, "audioset_16k", ".audioset_16k.complete", 2400),
        ):
            with self.subTest(folder=folder), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                corpus = root / folder
                corpus.mkdir()
                (corpus / "clip_0.wav").write_bytes(b"partial")
                calls = []
                interrupted = True
                def rows():
                    for index in range(size):
                        if interrupted and index == 1:
                            raise RuntimeError("download interrupted")
                        yield {"audio": {"path": f"clip_{index}.wav", "array": []}}
                class Dataset:
                    def __iter__(self): return rows()
                    def cast_column(self, *args): return self
                def loader(*args, **kwargs):
                    calls.append(args)
                    return Dataset()
                datasets = types.SimpleNamespace(load_dataset=loader, Audio=lambda **kwargs: None)
                with patch.dict(sys.modules, {**modules, "datasets": datasets}), patch.object(download, "WORK_DIR", root):
                    with self.assertRaisesRegex(RuntimeError, "interrupted"):
                        function()
                    self.assertFalse((root / marker).exists())
                    interrupted = False
                    function()
                    self.assertEqual(len(list(corpus.glob("*.wav"))), size)
                    self.assertTrue((root / marker).exists())
                    self.assertEqual((corpus / "clip_0.wav").read_bytes(), b"audio")
                    function()
                    self.assertEqual(len(calls), 2)
                    # Deleting a completed corpus leaves its external marker.
                    # A failed re-download must invalidate that stale marker.
                    shutil.rmtree(corpus)
                    interrupted = True
                    with self.assertRaisesRegex(RuntimeError, "interrupted"):
                        function()
                    self.assertFalse((root / marker).exists())
                    interrupted = False
                    function()
                    self.assertEqual(len(calls), 4)
                    self.assertEqual(len(list(corpus.glob("*.wav"))), size)
                    self.assertEqual(len(list(corpus.iterdir())), size)  # markers stay out of audio directories


if __name__ == "__main__":
    unittest.main()
