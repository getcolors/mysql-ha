import re
from pathlib import Path

import pytest
from blue.workflow import StepError
from conftest import ROOT, fixture
from package_mysql_ha_blue import tools, workflow
from package_mysql_ha_blue.cli import run

CREATE = {"blue/event": "create"}
BUILD = {"blue/event": "build"}
DELETE = {"blue/event": "delete"}
HEALTH = {"blue/event": "health"}

CREDENTIALS = {
    "mysql-admin-password": "a",
    "mysql-replication-password": "b",
    "backup-r2-access-key-id": "c",
    "backup-r2-secret-access-key": "d",
    "do-token": "e",
    "cloudflare-api-token": "f",
}


def recorded() -> dict:
    """`params` as a converged deployment records it."""
    return {"provider": "digitalocean",
            "reserved_ip": "203.0.113.10",
            "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
            "vpc_ip_range": "10.110.0.0/20",
            "nodes": [{"index": i, "role": None, "name": f"fixture-node-{i + 1}",
                       "ip": f"203.0.113.1{i + 1}", "vpc_ip": f"10.110.0.{5 + i}",
                       "droplet_id": 512000001 + i, "user": "root", "sudoer": "root"}
                      for i in range(3)]}


# The compute state is read once per run, through `tools.state_output`, on a
# real create, delete or health. Every lifecycle test replaces it: None is a
# readable state holding no compute, a dict is a recorded `params`, and a
# raise is a backend that cannot be read.
@pytest.fixture
def state(monkeypatch):
    def install(value):
        async def stub(_opts):
            return value
        monkeypatch.setattr(tools, "state_output", stub)
    return install


@pytest.fixture
def unreadable(monkeypatch):
    # The shape `blue.tofu` raises: the SDK's StepError. Only that is an
    # unreadable backend; anything else propagates as a defect.
    async def boom(_opts):
        raise StepError("tofu output failed: no backend")
    monkeypatch.setattr(tools, "state_output", boom)


@pytest.fixture
def never(monkeypatch):
    async def boom(_opts):
        raise AssertionError("the reader must not run")
    monkeypatch.setattr(tools, "state_output", boom)


def nexts(step: str, run_opts: dict) -> list[str]:
    return list((workflow.wire_fn(step, run_opts) or ())[1:])


def test_create_forks_at_the_infrastructure_and_joins_at_the_cluster():
    assert nexts("mysql-ha/start", CREATE) == ["mysql-ha/infrastructure"]
    assert nexts("mysql-ha/infrastructure", CREATE) == ["mysql-ha/dns", "mysql-ha/base"]
    # Both branches converge on one step, so the engine joins them once.
    assert nexts("mysql-ha/dns", CREATE) == ["mysql-ha/cluster"]
    assert nexts("mysql-ha/base", CREATE) == ["mysql-ha/cluster"]
    assert nexts("mysql-ha/cluster", CREATE) == ["mysql-ha/backup"]
    assert nexts("mysql-ha/backup", CREATE) == ["mysql-ha/health"]
    assert nexts("mysql-ha/health", CREATE) == []


def test_build_walks_the_same_graph_as_create():
    for step in ["mysql-ha/start", "mysql-ha/infrastructure", "mysql-ha/dns",
                 "mysql-ha/base", "mysql-ha/cluster", "mysql-ha/backup"]:
        assert nexts(step, BUILD) == nexts(step, CREATE)


def test_delete_reads_state_first_and_destroys_in_reverse():
    assert nexts("mysql-ha/start", DELETE) == ["mysql-ha/load-infrastructure"]
    assert nexts("mysql-ha/load-infrastructure", DELETE) == ["mysql-ha/cleanup"]
    assert nexts("mysql-ha/cleanup", DELETE) == ["mysql-ha/dns"]
    assert nexts("mysql-ha/dns", DELETE) == ["mysql-ha/infrastructure"]
    assert nexts("mysql-ha/infrastructure", DELETE) == []


def test_health_changes_nothing():
    assert nexts("mysql-ha/start", HEALTH) == ["mysql-ha/load-infrastructure"]
    assert nexts("mysql-ha/load-infrastructure", HEALTH) == ["mysql-ha/health"]
    assert workflow.wire_fn("mysql-ha/health", HEALTH)[0] is tools.health_step
    # No stage that converges anything is reachable from health.
    for fn in [workflow.wire_fn("mysql-ha/load-infrastructure", HEALTH)[0],
               workflow.wire_fn("mysql-ha/health", HEALTH)[0]]:
        assert fn not in (tools.infrastructure_step, tools.dns_step, tools.cluster_step)


async def test_a_build_needs_no_credential():
    result = await workflow.start_step(fixture(BUILD), env={})
    assert result["blue/exit"] == 0


async def test_build_and_dry_run_never_read_the_state(unreadable):
    # A raising reader proves nothing on these paths reaches the backend.
    for opts in [fixture(BUILD),
                 fixture({**CREATE, "blue/dry-run": True}),
                 fixture({**DELETE, "blue/dry-run": True}),
                 fixture({**HEALTH, "blue/dry-run": True})]:
        result = await workflow.start_step(opts, env={})
        assert result["blue/exit"] == 0
        assert "mysql-ha/state" not in result


async def test_a_real_run_refuses_without_credentials(state):
    state(None)
    result = await workflow.start_step(fixture(CREATE), env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_MYSQL_ADMIN_PASSWORD" in result["blue/err"]


async def test_a_dry_run_needs_no_credential():
    result = await workflow.start_step(
        fixture({**CREATE, "blue/dry-run": True}), env={})
    assert result["blue/exit"] == 0


async def test_the_profile_parameter_is_refused_before_anything_else(never):
    result = await workflow.start_step(fixture(BUILD),
                                       env={"COLORS_PAR_PROFILE": "elsewhere"})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_PROFILE" in result["blue/err"]
    # The state is not read for a refused profile, nor for invalid desired
    # state.
    result = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}),
        env={"COLORS_PAR_PROFILE": "elsewhere"})
    assert result["blue/exit"] == 2
    result = await workflow.start_step(
        fixture({**DELETE, "cluster-nodes": 2, **CREDENTIALS}), env={})
    assert result["blue/exit"] == 2


async def test_the_destroy_guard_holds_and_lifts_for_exactly_one_run(state):
    state(None)
    held = await workflow.start_step(fixture({**DELETE, **CREDENTIALS}), env={})
    assert held["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in held["blue/err"]
    lifted = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}),
        env={})
    assert lifted["blue/exit"] == 0


def test_defaults_do_not_quietly_permit_destruction():
    assert workflow.DEFAULTS["compute-prevent-destroy"] is True


# --- the Compute Cluster Standard's safety boundaries -----------------------

async def test_a_provider_switch_is_refused_before_the_credentials(state):
    state({**recorded(), "provider": "vultr"})
    for event in ("create", "delete", "health"):
        r = await workflow.start_step(
            fixture({"blue/event": event, "compute-prevent-destroy": False}), env={})
        assert r["blue/exit"] == 2, event
        assert "state holds a vultr machine; set provider-compute back to vultr and delete first" \
            in r["blue/err"]
        # The validator order is the thing under test: the actionable error,
        # not a missing token for the provider that was just selected.
        assert "required credential is not set" not in r["blue/err"]


async def test_legacy_state_accepts_only_the_default_provider(state):
    # A recorded provider is absent from every pre-adoption state; on the one
    # provider this package offers that is the default, and the run proceeds
    # to its credentials. A second provider would be refused by selection
    # before the state is read, so the other branch of the rule has no
    # reachable input here.
    state({k: v for k, v in recorded().items() if k != "provider"})
    for event in ("create", "delete", "health"):
        r = await workflow.start_step(
            fixture({"blue/event": event, "compute-prevent-destroy": False}), env={})
        assert r["blue/exit"] == 2, event
        assert "state holds" not in r["blue/err"], event
        assert "required credential is not set" in r["blue/err"], event


async def test_a_matching_provider_passes_to_the_credentials(state):
    state(recorded())
    r = await workflow.start_step(fixture(CREATE), env={})
    assert r["blue/exit"] == 2
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_an_unreadable_backend_counts_as_no_state_on_create(unreadable):
    # A fresh clone has no readable state and must still be able to create.
    r = await workflow.start_step(fixture(CREATE), env={})
    assert r["blue/exit"] == 2
    assert "could not read" not in r["blue/err"]
    assert "state holds" not in r["blue/err"]
    assert "COLORS_PAR_DO_TOKEN" in r["blue/err"]


async def test_a_real_create_on_a_fresh_work_directory_reports_the_credentials_not_a_crash(tmp_path):
    # No reader stub: the real `state_output` runs against a work directory
    # that holds no stage yet, as a fresh clone's does. It renders the stage,
    # writes its local backend and initializes it, and finds no state — or
    # fails to launch tofu, which the SDK reports as its StepError. Either way
    # ONCE's `read_state` counts it as no usable state, so the create reports
    # its credentials instead of crashing.
    result = await workflow.start_step(
        fixture({"workdir": str(tmp_path), **CREATE}), env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_DO_TOKEN" in result["blue/err"]
    assert "could not read" not in result["blue/err"]


async def test_an_unreadable_backend_fails_a_real_delete_closed(unreadable):
    # Swallowing it is how a teardown ends up converging against 192.0.2.11.
    # Preflight hands the read on; `load-infrastructure`, the first step after
    # it and before any side effect, is where the delete stops.
    r = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}), env={})
    assert r["blue/exit"] == 0
    assert r["mysql-ha/state"] == {"error": "tofu output failed: no backend"}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in loaded["blue/err"]
    assert "no backend" in loaded["blue/err"]


async def test_a_real_delete_adopts_the_recorded_cluster(state):
    state(recorded())
    r = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}), env={})
    assert r["blue/exit"] == 0
    assert r["mysql-ha/state"] == {"params": recorded()}
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 0
    assert loaded["once/cluster"] == recorded()
    assert [n["public-ip"] for n in tools.nodes(loaded)] == \
        ["203.0.113.11", "203.0.113.12", "203.0.113.13"]
    # A readable state without a cluster leaves nothing to clean up.
    state(None)
    r = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}), env={})
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 0
    assert loaded["mysql-ha/infrastructure-present?"] is False


async def test_a_partial_cluster_is_refused_on_a_real_run(state):
    params = recorded()
    state({**params, "nodes": params["nodes"][:2]})
    r = await workflow.start_step(fixture({**HEALTH, **CREDENTIALS}), env={})
    # The switch guard reads only the provider.
    assert r["blue/exit"] == 0
    loaded = await tools.load_infrastructure_step(r)
    assert loaded["blue/exit"] == 1
    assert loaded["blue/err"] == "the compute stage did not report nodes this package declares: 2"


def test_every_side_effecting_step_is_skipped_by_dry_run():
    for event in ("create", "delete", "health"):
        wired = [step for step in workflow.side_effecting
                 if workflow.wire_fn(step, {"blue/event": event})]
        assert all(step in workflow.side_effecting for step in wired)


async def test_a_whole_build_renders_every_stage():
    result = await run("build", "-f", str(ROOT / "test" / "fixtures" / "colors.yml"))
    assert result["blue/exit"] == 0
    root = ROOT / "test" / "fixtures" / ".colors" / "mysql-ha-fixture"
    for stage in ["mysql-ha-infrastructure", "mysql-ha-dns", "mysql-ha-ansible"]:
        assert (root / stage).is_dir(), stage
    # The backend is written by advice, before the stage runs.
    assert (root / "mysql-ha-infrastructure" / "backend.tf.json").exists()
    assert (root / "mysql-ha-dns" / "backend.tf.json").exists()
    # Nothing that looks like a credential is written.
    for file in [p for p in Path(root).rglob("*") if p.is_file()]:
        assert not re.search(r"REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY",
                             file.read_text()), file
