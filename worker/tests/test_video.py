from __future__ import annotations

import pytest

from ttcut_worker import video
from ttcut_worker.errors import VideoError


@pytest.mark.parametrize("filename", ["match.mp4", "IMG_7818.MOV"])
def test_validate_video_path_accepts_supported_suffixes(tmp_path, filename):
    path = tmp_path / filename
    path.write_bytes(b"video")

    assert video.validate_video_path(path) == path.resolve()


def test_validate_video_path_rejects_unsupported_suffix(tmp_path):
    path = tmp_path / "match.mkv"
    path.write_bytes(b"video")

    with pytest.raises(VideoError, match="MP4 or MOV"):
        video.validate_video_path(path)
