from __future__ import annotations

import gc
import weakref
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import pytest

from ttcut_worker import predictor as predictor_module
from ttcut_worker.errors import DeviceError
from ttcut_worker.model import LoadedTrackNet
from ttcut_worker.predictor import TrackNetPredictor
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.video import FramePacket, VideoInfo


def _packet(index: int) -> FramePacket:
    return FramePacket(index=index, time=float(index), time_source="fps_estimation", frame_bgr=None)


def _video_info() -> VideoInfo:
    return VideoInfo(
        path=Path("video.mp4"),
        width=1920,
        height=1080,
        fps=30.0,
        metadata_frame_count=0,
        decoded_frame_count=0,
        duration=0.0,
    )


def _predictor(device: str = "mps", batch_size: int = 8, model=None) -> TrackNetPredictor:
    loaded = LoadedTrackNet(model=model, seq_len=8, bg_mode="", device=device)
    return TrackNetPredictor(loaded, batch_size=batch_size)


def _pending(count: int, start: int = 0):
    inputs = [object() for _ in range(count)]
    packet_groups = [[_packet(index)] for index in range(start, start + count)]
    return inputs, packet_groups


def test_infer_with_backoff_retries_only_pending_inputs_and_keeps_reduced_batch(monkeypatch):
    predictor = _predictor(batch_size=8)
    calls: list[int] = []
    cache_calls: list[int] = []

    def fake_infer_batch(inputs, packet_groups, info):
        calls.append(len(inputs))
        if len(inputs) > 2:
            raise predictor_module._AcceleratorOutOfMemory("out of memory")
        return [packet.index for group in packet_groups for packet in group]

    monkeypatch.setattr(predictor, "_infer_batch", fake_infer_batch)
    monkeypatch.setattr(
        predictor, "_clear_accelerator_cache", lambda: cache_calls.append(calls[-1]),
    )
    inputs, packet_groups = _pending(8)

    result = predictor._infer_with_backoff(inputs, packet_groups, _video_info())

    assert result == list(range(8))
    assert calls == [8, 4, 2, 2, 2, 2]
    assert cache_calls == [8, 4]
    assert predictor.effective_batch_size == 2

    calls.clear()
    inputs, packet_groups = _pending(4, start=8)
    assert predictor._infer_with_backoff(inputs, packet_groups, _video_info()) == [8, 9, 10, 11]
    assert calls == [2, 2]
    assert cache_calls == [8, 4]


def test_infer_with_backoff_does_not_repeat_success_before_later_oom(monkeypatch):
    predictor = _predictor(batch_size=4)
    calls: list[list[int]] = []

    def fail_second_chunk(inputs, packet_groups, info):
        indices = [packet.index for group in packet_groups for packet in group]
        calls.append(indices)
        if indices == [4, 5, 6, 7]:
            raise predictor_module._AcceleratorOutOfMemory("out of memory")
        return indices

    monkeypatch.setattr(predictor, "_infer_batch", fail_second_chunk)
    monkeypatch.setattr(predictor, "_clear_accelerator_cache", lambda: None)
    inputs, packet_groups = _pending(8)

    result = predictor._infer_with_backoff(inputs, packet_groups, _video_info())

    assert result == list(range(8))
    assert calls == [[0, 1, 2, 3], [4, 5, 6, 7], [4, 5], [6, 7]]
    assert predictor.effective_batch_size == 2


def test_infer_with_backoff_raises_device_error_when_one_input_still_oom(monkeypatch):
    predictor = _predictor(batch_size=8)

    def always_oom(inputs, packet_groups, info):
        raise predictor_module._AcceleratorOutOfMemory("out of memory")

    monkeypatch.setattr(predictor, "_infer_batch", always_oom)
    monkeypatch.setattr(predictor, "_clear_accelerator_cache", lambda: None)
    inputs, packet_groups = _pending(1)

    with pytest.raises(DeviceError, match="batch size 1"):
        predictor._infer_with_backoff(inputs, packet_groups, _video_info())

    assert predictor.effective_batch_size == 1


class _Cache:
    def __init__(self, available: bool = False):
        self.available = available
        self.empty_cache_calls = 0

    def is_available(self) -> bool:
        return self.available

    def empty_cache(self) -> None:
        self.empty_cache_calls += 1


class _CacheTorch:
    def __init__(self, cuda_available: bool = False):
        self.cuda = _Cache(cuda_available)
        self.mps = _Cache()


def test_clear_accelerator_cache_uses_mps_cache(monkeypatch):
    fake_torch = _CacheTorch()
    monkeypatch.setattr(predictor_module, "import_torch", lambda: fake_torch)

    _predictor(device="mps")._clear_accelerator_cache()

    assert fake_torch.mps.empty_cache_calls == 1
    assert fake_torch.cuda.empty_cache_calls == 0


def test_clear_accelerator_cache_uses_available_cuda_cache(monkeypatch):
    fake_torch = _CacheTorch(cuda_available=True)
    monkeypatch.setattr(predictor_module, "import_torch", lambda: fake_torch)

    _predictor(device="cuda")._clear_accelerator_cache()

    assert fake_torch.cuda.empty_cache_calls == 1
    assert fake_torch.mps.empty_cache_calls == 0


@pytest.mark.parametrize("device,cuda_available", [("cuda", False), ("cpu", True)])
def test_clear_accelerator_cache_ignores_unavailable_or_cpu_devices(
    monkeypatch, device, cuda_available,
):
    fake_torch = _CacheTorch(cuda_available=cuda_available)
    monkeypatch.setattr(predictor_module, "import_torch", lambda: fake_torch)

    _predictor(device=device)._clear_accelerator_cache()

    assert fake_torch.cuda.empty_cache_calls == 0
    assert fake_torch.mps.empty_cache_calls == 0


class _Tensor:
    def __init__(self, array):
        self.array = array

    def float(self):
        return self

    def to(self, device):
        return self


class _InferenceTorch:
    def from_numpy(self, array):
        return _Tensor(array)

    def no_grad(self):
        return nullcontext()


class _ThrowingModel:
    def __init__(self, message: str, error_type=RuntimeError):
        self.message = message
        self.error_type = error_type

    def __call__(self, tensor):
        raise self.error_type(self.message)


class _KernelLaunchError(RuntimeError):
    pass


class _Heatmaps:
    def __init__(self, batch_size: int):
        self.batch_size = batch_size

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return np.zeros((self.batch_size, 8, 1), dtype=np.float32)


class _MpsAllocationModel:
    def __init__(self):
        self.calls: list[int] = []

    def __call__(self, tensor):
        batch_size = len(tensor.array)
        self.calls.append(batch_size)
        if batch_size > 2:
            raise RuntimeError("MPS Invalid Buffer Size: allocation is too large")
        return _Heatmaps(batch_size)


def _run_infer_batch(predictor: TrackNetPredictor):
    return predictor._infer_batch(
        [np.zeros((1,), dtype=np.float32)], [[_packet(0)]], _video_info(),
    )


def test_infer_batch_classifies_out_of_memory_without_retaining_exception_chain(monkeypatch):
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    predictor = _predictor(model=_ThrowingModel("MPS OUT OF MEMORY"))

    with pytest.raises(predictor_module._AcceleratorOutOfMemory) as exc_info:
        _run_infer_batch(predictor)

    assert exc_info.value.__cause__ is None
    assert exc_info.value.__context__ is None


def test_mps_invalid_buffer_size_is_classified_and_reduces_batch(monkeypatch):
    model = _MpsAllocationModel()
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    monkeypatch.setattr(predictor_module, "heatmap_candidates", lambda *args: [])
    predictor = _predictor(device="mps", batch_size=4, model=model)
    inputs = [np.zeros((1,), dtype=np.float32) for _ in range(4)]
    packet_groups = [[_packet(index)] for index in range(4)]

    result = predictor._infer_with_backoff(inputs, packet_groups, _video_info())

    assert [point.frame for point in result] == [0, 1, 2, 3]
    assert model.calls == [4, 2, 2]
    assert predictor.effective_batch_size == 2


def test_cpu_invalid_buffer_size_is_not_classified_as_oom(monkeypatch):
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    predictor = _predictor(device="cpu", model=_ThrowingModel("Invalid Buffer Size: bad input"))

    with pytest.raises(RuntimeError, match="Invalid Buffer Size") as exc_info:
        _run_infer_batch(predictor)

    assert not isinstance(exc_info.value, predictor_module._AcceleratorOutOfMemory)


def test_infer_batch_preserves_non_oom_exception(monkeypatch):
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    predictor = _predictor(
        model=_ThrowingModel("kernel launch failed", error_type=_KernelLaunchError),
    )

    with pytest.raises(_KernelLaunchError) as exc_info:
        _run_infer_batch(predictor)

    assert str(exc_info.value) == "kernel launch failed"


def test_oom_conversion_releases_tensor_while_private_exception_is_held(monkeypatch):
    fake_torch = _InferenceTorch()
    tensor_ref = None

    def from_numpy(array):
        nonlocal tensor_ref
        tensor = _Tensor(array)
        tensor_ref = weakref.ref(tensor)
        return tensor

    fake_torch.from_numpy = from_numpy
    monkeypatch.setattr(predictor_module, "import_torch", lambda: fake_torch)
    predictor = _predictor(model=_ThrowingModel("MPS out of memory"))

    with pytest.raises(predictor_module._AcceleratorOutOfMemory) as exc_info:
        _run_infer_batch(predictor)

    gc.collect()
    assert tensor_ref is not None
    assert tensor_ref() is None
    assert isinstance(exc_info.value, predictor_module._AcceleratorOutOfMemory)


def test_predict_uses_reduced_threshold_and_processes_eof_partial_batch(monkeypatch):
    frame_count = 53

    class FakeReader:
        def __init__(self, video_path):
            self.info = VideoInfo(
                path=Path(video_path), width=1920, height=1080, fps=30.0,
                metadata_frame_count=frame_count, decoded_frame_count=None,
                duration=frame_count / 30.0,
            )

        def __iter__(self):
            for index in range(frame_count):
                yield FramePacket(
                    index=index,
                    time=index / 30.0,
                    time_source="fps_estimation",
                    frame_bgr=np.array([index], dtype=np.float32),
                )

        def final_info(self):
            return VideoInfo(
                path=self.info.path, width=self.info.width, height=self.info.height,
                fps=self.info.fps, metadata_frame_count=frame_count,
                decoded_frame_count=frame_count, duration=frame_count / 30.0,
                time_source_summary="fps_estimation",
            )

    predictor = _predictor(batch_size=4)
    predictor.effective_batch_size = 1
    calls: list[list[list[int]]] = []
    cache_calls = 0
    first_batch_failed = False

    def fake_infer_batch(inputs, packet_groups, info):
        nonlocal first_batch_failed
        calls.append([[packet.index for packet in group] for group in packet_groups])
        if len(inputs) == 4 and not first_batch_failed:
            first_batch_failed = True
            raise predictor_module._AcceleratorOutOfMemory("out of memory")
        return [
            TrajectoryPoint(
                packet.index,
                packet.time,
                0,
                0,
                0,
                "missing",
                0.0,
                packet.time_source,
            )
            for group in packet_groups
            for packet in group
        ]

    def clear_cache():
        nonlocal cache_calls
        cache_calls += 1

    monkeypatch.setattr(predictor_module, "StreamingVideoReader", FakeReader)
    monkeypatch.setattr(
        predictor, "_preprocess_frame", lambda frame_bgr, median_rgb: frame_bgr,
    )
    monkeypatch.setattr(predictor, "_infer_batch", fake_infer_batch)
    monkeypatch.setattr(predictor, "_clear_accelerator_cache", clear_cache)

    predictions, info, stats = predictor.predict("fake.mp4")

    assert [len(call) for call in calls] == [4, 2, 2, 2, 1]
    assert [call[0][0] for call in calls] == [0, 0, 16, 32, 48]
    assert calls[-1] == [list(range(48, 53))]
    assert [point.frame for point in predictions] == list(range(frame_count))
    assert info.decoded_frame_count == frame_count
    assert stats.missing_frames == frame_count
    assert predictor.effective_batch_size == 2
    assert cache_calls == 1
