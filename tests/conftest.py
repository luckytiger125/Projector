"""测试隔离：必须在模块顶层、import 任何项目模块之前设好临时目录（fixture 来不及）。"""
import os
import sys
import tempfile
from pathlib import Path

_root = Path(tempfile.mkdtemp(prefix="projector-test-"))
for _sub in ("data", "files", "workspaces", "kb"):
    (_root / _sub).mkdir(parents=True, exist_ok=True)
os.environ["PROJECTOR_DATA"] = str(_root / "data")
os.environ["FILES_ROOT"] = str(_root / "files")
os.environ["WORKSPACE_ROOT"] = str(_root / "workspaces")
os.environ["KB_ROOT"] = str(_root / "kb")
TEST_ROOT = _root

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

import store  # noqa: E402

_CLEAN_TABLES = ("usage_turns", "messages", "sessions", "tokens", "users", "sections", "doc_cache", "active_runs", "turn_queue")


@pytest.fixture(autouse=True)
def clean_db():
    """每个用例前后清空业务表。"""
    def wipe():
        for t in _CLEAN_TABLES:
            store.db(f"DELETE FROM {t}")
    wipe()
    yield
    wipe()


@pytest.fixture
def make_user():
    def _make(username, role="user", display_name=None):
        store.db("INSERT INTO users (username, display_name, pw_hash, role, created) VALUES (?,?,?,?,?)",
                 (username, display_name or username, "x", role, 0))
        uid = store.db("SELECT id FROM users WHERE username=?", (username,), one=True)["id"]
        token = store.issue_token(uid)
        return {"id": uid, "token": token, "headers": {"Authorization": f"Bearer {token}"}}
    return _make
