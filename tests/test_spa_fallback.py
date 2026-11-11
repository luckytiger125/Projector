"""前端路由回退：明确的前缀返回同一个 index.html；/api 下不存在的路径仍是 404。"""
import pytest
from fastapi.testclient import TestClient

import server  # noqa: E402  (conftest 已先设好临时目录)


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.mark.parametrize("path", ["/", "/s/abc", "/s/new/steps", "/kb/graph", "/admin/users", "/files", "/board",
                                  "/skills/foo", "/usage", "/mobile"])
def test_spa_pages(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
    assert "no-cache" in r.headers["cache-control"]
    assert '<div class="app" id="shell">' in r.text


def test_api_unknown_is_404(client):
    assert client.get("/api/nope").status_code == 404


def test_unlisted_prefix_is_404(client):
    assert client.get("/whatever/else").status_code == 404


def test_built_index_served_statically(client):
    r = client.get("/static/app/index.html")
    assert r.status_code == 200
    assert "/static/app/assets/" in r.text
