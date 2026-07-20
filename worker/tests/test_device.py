from __future__ import annotations

import pytest

from ttcut_worker import model as worker_model
from ttcut_worker.errors import DeviceError


class FakeCuda:
    def __init__(self, available: bool):
        self._available = available

    def is_available(self) -> bool:
        return self._available


class FakeMps:
    def __init__(self, available: bool):
        self._available = available

    def is_available(self) -> bool:
        return self._available


class FakeBackends:
    def __init__(self, mps_available: bool):
        self.mps = FakeMps(mps_available)


class FakeTorch:
    def __init__(self, cuda_available: bool, mps_available: bool):
        self.cuda = FakeCuda(cuda_available)
        self.backends = FakeBackends(mps_available)

    def device(self, value: str) -> str:
        return value


def patch_torch(monkeypatch: pytest.MonkeyPatch, cuda: bool, mps: bool) -> None:
    fake = FakeTorch(cuda, mps)
    monkeypatch.setattr(worker_model, "import_torch", lambda: fake)


def test_auto_prefers_cuda(monkeypatch: pytest.MonkeyPatch):
    patch_torch(monkeypatch, cuda=True, mps=True)
    assert worker_model.resolve_device("auto") == "cuda"


def test_auto_uses_mps_when_cuda_is_unavailable(monkeypatch: pytest.MonkeyPatch):
    patch_torch(monkeypatch, cuda=False, mps=True)
    assert worker_model.resolve_device("auto") == "mps"


def test_auto_falls_back_to_cpu(monkeypatch: pytest.MonkeyPatch):
    patch_torch(monkeypatch, cuda=False, mps=False)
    assert worker_model.resolve_device("auto") == "cpu"


def test_cuda_request_still_requires_cuda(monkeypatch: pytest.MonkeyPatch):
    patch_torch(monkeypatch, cuda=False, mps=True)
    with pytest.raises(DeviceError, match="CUDA"):
        worker_model.resolve_device("cuda")
