"""确认测试没有碰真实的 data/、知识库、工作区。"""
from pathlib import Path

import store
from conftest import TEST_ROOT


def _inside(p, root):
    return Path(p).resolve().is_relative_to(Path(root).resolve())


def test_paths_under_temp_root():
    for p in (store.DATA, store.FILE_ROOT, store.KB_ROOT, store.WS_ROOT, store.LIBRARY):
        assert _inside(p, TEST_ROOT), p
    assert not _inside(store.DATA, store.BASE / "data")


def test_database_file_is_temp():
    files = [r["file"] for r in store.db("PRAGMA database_list") if r["file"]]
    assert files
    for f in files:
        assert _inside(f, TEST_ROOT), f
        assert not _inside(f, store.BASE / "data")
