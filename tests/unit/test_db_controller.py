"""H8: the database controller's policy (decide) and the writer rule (pick_writer), without a database."""
import os

os.environ.setdefault("LOG_DIR", "/tmp/ft-test-logs")

from app.fault_tolerance.infrastructure.db_failover import NodeState, pick_writer  # noqa: E402
from app.services.db_controller import Action, Memory, decide  # noqa: E402

PRIMARY = NodeState(standby=False, fenced=False, timeline=1, standbys=1, sync_names="*")
PRIMARY_ALONE = NodeState(standby=False, fenced=False, timeline=1, standbys=0, sync_names="")
STANDBY = NodeState(standby=True, fenced=False)


def kinds(actions):
    return [(a.kind, a.node) for a in actions]


# ---- pick_writer ----

def test_writer_is_the_primary():
    assert pick_writer({"a": PRIMARY, "b": STANDBY}) == "a"


def test_no_writer_when_only_a_standby_answers():
    assert pick_writer({"a": None, "b": STANDBY}) is None


def test_highest_timeline_wins_over_a_stale_primary():
    promoted = NodeState(standby=False, fenced=False, timeline=2)
    assert pick_writer({"a": PRIMARY, "b": promoted}) == "b"


def test_fenced_primary_is_not_a_writer():
    fenced = NodeState(standby=False, fenced=True, timeline=5)
    assert pick_writer({"a": fenced, "b": NodeState(standby=False, fenced=False, timeline=2)}) == "b"
    assert pick_writer({"a": fenced, "b": STANDBY}) is None


def test_same_timeline_keeps_the_configured_primary():
    assert pick_writer({"a": PRIMARY, "b": PRIMARY}) == "a"


# ---- decide: promotion ----

def test_healthy_pair_in_sync_needs_no_action():
    memory = Memory()
    assert decide({"a": PRIMARY, "b": STANDBY}, memory) == []
    assert memory.standby_in_sync is True


def test_promotes_only_after_the_threshold():
    memory = Memory(standby_in_sync=True)
    down = {"a": None, "b": STANDBY}
    assert decide(down, memory, threshold=3) == []
    assert decide(down, memory, threshold=3) == []
    assert kinds(decide(down, memory, threshold=3)) == [("promote", "b")]


def test_a_blip_shorter_than_the_threshold_resets_the_count():
    memory = Memory(standby_in_sync=True)
    decide({"a": None, "b": STANDBY}, memory, threshold=3)
    decide({"a": None, "b": STANDBY}, memory, threshold=3)
    assert decide({"a": PRIMARY, "b": STANDBY}, memory, threshold=3) == []
    assert memory.no_writer == 0
    assert decide({"a": None, "b": STANDBY}, memory, threshold=3) == []  # counting starts again


def test_refuses_to_promote_a_standby_that_was_not_in_sync():
    memory = Memory(standby_in_sync=False)
    actions = [decide({"a": None, "b": STANDBY}, memory, threshold=2) for _ in range(2)][-1]
    assert actions == [Action("refuse", "b", "standby_not_in_sync")]


def test_no_promotion_when_no_standby_is_reachable():
    memory = Memory(standby_in_sync=True)
    for _ in range(5):
        assert decide({"a": None, "b": None}, memory, threshold=3) == []


# ---- decide: fencing ----

def test_fences_the_stale_primary_when_it_comes_back():
    promoted = NodeState(standby=False, fenced=False, timeline=2, standbys=0, sync_names="")
    actions = decide({"a": PRIMARY, "b": promoted}, Memory())
    assert ("fence", "a") in kinds(actions)
    assert ("fence", "b") not in kinds(actions)


def test_does_not_fence_twice():
    promoted = NodeState(standby=False, fenced=False, timeline=2)
    fenced = NodeState(standby=False, fenced=True, timeline=1)
    assert all(a.kind != "fence" for a in decide({"a": fenced, "b": promoted}, Memory()))


# ---- decide: synchronous replication ----

def test_turns_sync_on_when_a_standby_streams():
    async_with_standby = NodeState(standby=False, fenced=False, timeline=1, standbys=1, sync_names="")
    memory = Memory()
    assert kinds(decide({"a": async_with_standby, "b": STANDBY}, memory)) == [("sync_on", "a")]
    assert memory.standby_in_sync is False  # not until the setting is seen in effect


def test_turns_sync_off_after_the_grace_period_without_a_standby():
    sync_no_standby = NodeState(standby=False, fenced=False, timeline=1, standbys=0, sync_names="*")
    memory = Memory(standby_in_sync=True)
    assert decide({"a": sync_no_standby, "b": None}, memory, sync_grace=2) == []
    assert kinds(decide({"a": sync_no_standby, "b": None}, memory, sync_grace=2)) == [("sync_off", "a")]
    assert memory.standby_in_sync is False


def test_primary_alone_and_async_is_left_alone():
    memory = Memory()
    assert decide({"a": PRIMARY_ALONE, "b": None}, memory) == []
    assert memory.standby_in_sync is False
