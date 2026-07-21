from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path

import numpy as np
import pytest

from ttcut_worker import predictor as predictor_module
from ttcut_worker.errors import DeviceError
from ttcut_worker.model import LoadedTrackNet
from ttcut_worker.predictor import TrackNetPredictor
from ttcut_worker.video import FramePacket, VideoInfo


def _packet(index: int) -> FramePacket:
    return FramePacket(index=index, time=float(index), time_source="fps", frame_bgr=None)


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

    def fake_infer_batch(inputs, packet_groups, info):
        calls.append(len(inputs))
        if len(inputs) > 2:
            raise predictor_module._AcceleratorOutOfMemory("out of memory")
        return [packet.index for group in packet_groups for packet in group]

    monkeypatch.setattr(predictor, "_infer_batch", fake_infer_batch)
    monkeypatch.setattr(predictor, "_clear_accelerator_cache", lambda: None)
    inputs, packet_groups = _pending(8)

    result = predictor._infer_with_backoff(inputs, packet_groups, _video_info())

    assert result == list(range(8))
    assert calls == [8, 4, 2, 2, 2, 2]
    assert predictor.effective_batch_size == 2

    calls.clear()
    inputs, packet_groups = _pending(4, start=8)
    assert predictor._infer_with_backoff(inputs, packet_groups, _video_info()) == [8, 9, 10, 11]
    assert calls == [2, 2]


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
    def float(self):
        return self

    def to(self, device):
        return self


class _InferenceTorch:
    def from_numpy(self, array):
        return _Tensor()

    def no_grad(self):
        return nullcontext()


class _ThrowingModel:
    def __init__(self, error: Exception):
        self.error = error

    def __call__(self, tensor):
        raise self.error


def _run_infer_batch(predictor: TrackNetPredictor):
    return predictor._infer_batch(
        [np.zeros((1,), dtype=np.float32)], [[_packet(0)]], _video_info(),
    )


def test_infer_batch_classifies_out_of_memory_without_retaining_exception_chain(monkeypatch):
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    predictor = _predictor(model=_ThrowingModel(RuntimeError("MPS OUT OF MEMORY")))

    with pytest.raises(predictor_module._AcceleratorOutOfMemory) as exc_info:
        _run_infer_batch(predictor)

    assert exc_info.value.__cause__ is None
    assert exc_info.value.__context__ is None


def test_infer_batch_preserves_non_oom_exception(monkeypatch):
    monkeypatch.setattr(predictor_module, "import_torch", lambda: _InferenceTorch())
    error = RuntimeError("kernel launch failed")
    predictor = _predictor(model=_ThrowingModel(error))

    with pytest.raises(RuntimeError) as exc_info:
        _run_infer_batch(predictor)

    assert exc_info.value is error
