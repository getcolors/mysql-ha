import re
from pathlib import Path

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


async def test_a_real_run_refuses_without_credentials():
    result = await workflow.start_step(fixture(CREATE), env={})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_MYSQL_ADMIN_PASSWORD" in result["blue/err"]


async def test_a_dry_run_needs_no_credential():
    result = await workflow.start_step(
        fixture({**CREATE, "blue/dry-run": True}), env={})
    assert result["blue/exit"] == 0


async def test_the_profile_parameter_is_refused_before_anything_else():
    result = await workflow.start_step(fixture(BUILD),
                                       env={"COLORS_PAR_PROFILE": "elsewhere"})
    assert result["blue/exit"] == 2
    assert "COLORS_PAR_PROFILE" in result["blue/err"]


async def test_the_destroy_guard_holds_and_lifts_for_exactly_one_run():
    held = await workflow.start_step(fixture({**DELETE, **CREDENTIALS}), env={})
    assert held["blue/exit"] == 2
    assert "COMPUTE_PREVENT_DESTROY" in held["blue/err"]
    lifted = await workflow.start_step(
        fixture({**DELETE, "compute-prevent-destroy": False, **CREDENTIALS}),
        env={})
    assert lifted["blue/exit"] == 0


def test_defaults_do_not_quietly_permit_destruction():
    assert workflow.DEFAULTS["compute-prevent-destroy"] is True


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
