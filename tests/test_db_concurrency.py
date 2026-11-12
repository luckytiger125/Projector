"""数据库读写分离：读不排在写锁后面，写完别的线程立刻读得到。"""
import threading
import time

import store


def test_wal_enabled():
    assert store._db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"


def test_read_does_not_wait_for_write_lock():
    out = []
    with store._db_lock:   # 模拟另一个请求正占着写锁（比如一批大的写入）
        t = threading.Thread(target=lambda: out.append(store.db("SELECT COUNT(*) AS c FROM users", one=True)))
        t.start()
        t.join(5)
        assert not t.is_alive(), "读被写锁挡住了"
    assert out and "c" in out[0]


def test_write_is_visible_to_other_threads_immediately():
    store.set_setting("probe_rw", "1")
    seen = []
    t = threading.Thread(target=lambda: seen.append(store.get_setting("probe_rw")))
    t.start(); t.join(5)
    assert seen == ["1"]
    assert store.get_setting("probe_rw") == "1"


def test_reader_connection_cannot_write():
    import sqlite3
    import pytest
    with pytest.raises(sqlite3.OperationalError):
        store._reader().execute("DELETE FROM settings")
    store.set_setting("probe_after_fail", "x")   # 出错后只读连接不能停在旧快照上
    assert store.get_setting("probe_after_fail") == "x"


def test_failed_write_rolls_back_and_releases_lock():
    import sqlite3
    import pytest
    with pytest.raises(sqlite3.Error):
        store.db("INSERT INTO no_such_table VALUES (1)")
    assert store._db_lock.acquire(timeout=1)
    store._db_lock.release()


def test_many_threads_mixed_read_write():
    errors = []

    def work(i):
        try:
            for j in range(20):
                store.set_setting(f"mix_{i}", str(j))
                assert store.get_setting(f"mix_{i}") == str(j)
        except Exception as e:   # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(20)
    assert not errors
