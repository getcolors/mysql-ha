import json

from conftest import fixture
from package_mysql_ha_blue import tools, utils


def test_the_topology_is_a_pure_function_of_desired_state():
    assert tools.nodes(fixture()) == tools.nodes(fixture())
    assert [n["name"] for n in tools.nodes(fixture())] == \
        ["fixture-node-1", "fixture-node-2", "fixture-node-3"]
    assert [n["server-id"] for n in tools.nodes(fixture())] == [101, 102, 103]
    # The archiver's pseudo-replica ids cannot collide with a member's.
    server_ids = {n["server-id"] for n in tools.nodes(fixture())}
    connection_ids = {n["connection-server-id"] for n in tools.nodes(fixture())}
    assert not server_ids & connection_ids


def test_every_member_seeds_from_every_member():
    seeds = tools.group_seeds({**tools.fallback_outputs, **fixture()})
    assert len(seeds.split(",")) == 3
    assert ":33061" in seeds


def test_the_inventory_names_both_groups():
    inv = json.loads(tools.inventory(fixture()))
    children = inv["all"]["children"]
    assert len(children["mysql"]["hosts"]) == 3
    assert list(children["bootstrap"]["hosts"]) == ["fixture-node-1"]
    # Bootstrap is only ever member one, and only for an empty group.
    assert children["bootstrap"]["hosts"]["fixture-node-1"] == \
        children["mysql"]["hosts"]["fixture-node-1"]
    assert children["mysql"]["hosts"]["fixture-node-2"][
        "ansible_ssh_private_key_file"] == "~/.ssh/id_ed25519"


def test_the_inventory_is_byte_stable():
    assert tools.inventory(fixture()) == tools.inventory(fixture())


def test_build_never_reads_state():
    # Fallback addresses are documentation range, so a leak fails loudly.
    assert all(ip.startswith("192.0.2.")
               for ip in tools.fallback_outputs["node_public_ips"])
    assert tools.fallback_outputs["reserved_ip"].startswith("192.0.2.")


def test_stage_directories_are_remote_state_keys():
    for tool in tools.tofu_tools:
        assert tools.tool_dir(fixture(), tool).endswith(f"/{tool}")
    assert tools.tofu_tools == ["mysql-ha-infrastructure", "mysql-ha-dns"]


def test_the_rendered_tree_is_exactly_what_a_member_needs():
    targets = [s["target"] for s in tools.ansible_specs(fixture())]
    names = {target.rsplit("/", 1)[-1] for target in targets}
    assert names >= {
        "ansible.cfg", "base.yml", "cluster.yml", "backup.yml",
        "health.yml", "cleanup.yml", "inventory.json",
        "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
        "mysql-ha-lib", "mysql-ha-endpoint", "mysql-ha-heartbeat",
        "mysql-ha-snapshot", "mysql-ha-binlog-archive",
        "mysql-ha-binlog-upload", "mysql-ha-restore-check", "mysql-ha-health"}
    # No file holding a credential is ever rendered.
    assert not names & {"rclone.conf", "secrets.env", "binlog-client.cnf"}


def test_the_dns_stage_points_at_the_reserved_ip_and_the_members():
    data = tools.dns_specs(fixture())[0]["data"]
    records = json.loads(data["node-records-json"])
    assert data["reserved_ip"] == tools.fallback_outputs["reserved_ip"]
    assert list(records) == ["node-1.my-ha.fixture.example",
                             "node-2.my-ha.fixture.example",
                             "node-3.my-ha.fixture.example"]


def test_the_backup_prefix_never_carries_a_trailing_slash():
    assert utils.backup_prefix(fixture()) == "mysql-ha-fixture"
    assert utils.backup_prefix({"backup-r2-prefix": "a/b//"}) == "a/b"
