"""Fixtures for the server tests. Run from the repo root with:  python -m pytest

Each test file is one scenario: its tests run in order and share one copy of the pack and one scratch
folder (they build on each other's library), so run whole files, not single tests.
"""
import os

import pytest
from PIL import Image

from helpers import load_pack

# The four files the scenarios add to libraries: made here, so nothing binary lives in the repo.
_FIXTURES = {"Buttons.png": (200, 60, 40), "Giftwood.png": (40, 160, 70), "Biscuit.png": (60, 80, 200), "CAPIBARA.jpg": (150, 110, 60)}


@pytest.fixture(scope="session")
def image_dir(tmp_path_factory):
    folder = tmp_path_factory.mktemp("input")
    for name, color in _FIXTURES.items():
        im = Image.new("RGB", (640, 480), color)
        im.paste((255, 255, 255), (40, 40, 200, 160))  # not one flat color
        im.save(folder / name)
    return str(folder)


@pytest.fixture(scope="module")
def img(image_dir):
    """img("Buttons.png") -> full path of that fixture image."""
    return lambda name: os.path.join(image_dir, name)


@pytest.fixture(scope="module")
def scratch(tmp_path_factory):
    """Stands in for ComfyUI's user folder (library.json, backups) and holds files a scenario makes."""
    return str(tmp_path_factory.mktemp("scratch"))


@pytest.fixture(scope="module")
def pack(scratch):
    return load_pack(scratch)
