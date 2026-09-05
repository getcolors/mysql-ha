import json

import pytest
from blue.workflow import StepError
from conftest import fixture, optout
from package_mysql_ha_blue import tools, utils, validate
from package_once_blue import compute_cluster as cluster

# A pre-adoption state exactly as `tofu output -json` parsed it: the six
# outputs, three parallel lists among them, and no `params`.
LEGACY_OUTPUTS = {
    "node_public_ips": ["203.0.113.11", "203.0.113.12", "203.0.113.13"],
    "node_private_ips": ["10.110.0.5", "10.110.0.6", "10.110.0.7"],
    "node_droplet_ids": [512000001, 512000002, 512000003],
    "reserved_ip": "203.0.113.10",
    "vpc_id": "5a6b7c8d-0000-4000-8000-000000000001",
    "vpc_ip_range": "10.110.0.0/20",
}


def recorded() -> dict:
    """`params` as the adopted template records it, here through the legacy
    translation so the two shapes are provably one."""
    return tools.legacy_params(fixture(), LEGACY_OUTPUTS)


def test_the_topology_is_a_pure_function_of_desired_state():
    assert tools.nodes(fixture()) == tools.nodes(fixture())
    assert [n["name"] for n in tools.nodes(fixture())] == \
        ["fixture-node-1", "fixture-node-2", "fixture-node-3"]
    assert [n["server-id"] for n in tools.nodes(fixture())] == [101, 102, 103]
    # The archiver's pseudo-replica ids cannot collide with a member's.
    server_ids = {n["server-id"] for n in tools.nodes(fixture())}
    connection_ids = {n["connection-server-id"] for n in tools.nodes(fixture())}
    assert not server_ids & connection_ids


def test_build_never_reads_state():
    # ONCE's fallbacks at offset 11 are the addresses this package always
    # rendered; documentation range, so a leak fails loudly.
    assert [n["public-ip"] for n in tools.nodes(fixture())] == \
        ["192.0.2.11", "192.0.2.12", "192.0.2.13"]
    assert [n["private-ip"] for n in tools.nodes(fixture())] == \
        ["10.110.0.11", "10.110.0.12", "10.110.0.13"]
    assert [n["droplet-id"] for n in tools.nodes(fixture())] == \
        [100000001, 100000002, 100000003]
    assert tools.fallback_outputs["reserved_ip"].startswith("192.0.2.")
    assert tools.data_fn(fixture())["reserved_ip"] == tools.fallback_outputs["reserved_ip"]


def test_a_real_run_reads_every_node_from_the_adopted_cluster():
    opts = fixture({"once/cluster": recorded()})
    members = tools.nodes(opts)
    assert [n["public-ip"] for n in members] == ["203.0.113.11", "203.0.113.12", "203.0.113.13"]
    assert [n["private-ip"] for n in members] == ["10.110.0.5", "10.110.0.6", "10.110.0.7"]
    assert [n["droplet-id"] for n in members] == [512000001, 512000002, 512000003]
    assert [n["name"] for n in members] == ["fixture-node-1", "fixture-node-2", "fixture-node-3"]
    # The cluster facts beside the nodes come from state too.
    assert tools.data_fn(opts)["reserved_ip"] == "203.0.113.10"
    assert tools.data_fn(opts)["vpc_id"] == "5a6b7c8d-0000-4000-8000-000000000001"
    assert tools.group_seeds(opts) == "10.110.0.5:33061,10.110.0.6:33061,10.110.0.7:33061"
    # And reach the inventory and the DNS records.
    inv = json.loads(tools.inventory(opts))
    assert inv["all"]["children"]["mysql"]["hosts"]["fixture-node-2"]["ansible_host"] == "203.0.113.12"
    records = json.loads(tools.dns_specs(opts)[0]["data"]["node-records-json"])
    assert records["node-3.my-ha.fixture.example"] == "203.0.113.13"


def test_the_legacy_state_is_translated_into_params():
    params = recorded()
    assert params["provider"] == "digitalocean"
    assert [n["index"] for n in params["nodes"]] == [0, 1, 2]
    assert all(n["role"] is None for n in params["nodes"])
    assert [n["name"] for n in params["nodes"]] == \
        ["fixture-node-1", "fixture-node-2", "fixture-node-3"]
    second = params["nodes"][1]
    assert {k: second[k] for k in ["ip", "vpc_ip", "droplet_id", "user", "sudoer"]} == \
        {"ip": "203.0.113.12", "vpc_ip": "10.110.0.6", "droplet_id": 512000002,
         "user": "root", "sudoer": "root"}
    assert [params[k] for k in ["reserved_ip", "vpc_id", "vpc_ip_range"]] == \
        ["203.0.113.10", "5a6b7c8d-0000-4000-8000-000000000001", "10.110.0.0/20"]
    # ONCE accepts the translation as a whole cluster.
    assert not cluster.node_errors(validate.spec, fixture(), params)
    assert tools.params_errors(params) == []


def test_the_legacy_translation_refuses_to_guess():
    def refusal(outputs):
        with pytest.raises(StepError) as e:
            tools.legacy_params(fixture(), outputs)
        return str(e.value)

    # Lists that disagree with each other; the SDK's StepError, so read_state
    # reports it.
    assert refusal({**LEGACY_OUTPUTS, "node_public_ips": ["203.0.113.11", "203.0.113.12"]}) == \
        "legacy state lists 2 public addresses, 3 private addresses and 3 droplet ids; refusing to guess the cluster"
    # Lists that disagree with cluster-nodes.
    four = {k: [*LEGACY_OUTPUTS[k], LEGACY_OUTPUTS[k][-1]]
            for k in ["node_public_ips", "node_private_ips", "node_droplet_ids"]}
    assert refusal({**LEGACY_OUTPUTS, **four}) == \
        "legacy state lists 4 public addresses, 4 private addresses and 4 droplet ids; refusing to guess the cluster"
    # No reserved ip.
    without = {k: v for k, v in LEGACY_OUTPUTS.items() if k != "reserved_ip"}
    assert refusal(without) == "legacy state carries no reserved_ip"
    assert refusal({**LEGACY_OUTPUTS, "reserved_ip": ""}) == "legacy state carries no reserved_ip"
    # The other extension keys are params_errors' to refuse, the same as a
    # recorded state.
    no_vpc = {k: v for k, v in LEGACY_OUTPUTS.items() if k != "vpc_id"}
    assert tools.params_errors(tools.legacy_params(fixture(), no_vpc)) == \
        ["compute state carries no vpc_id"]


def test_params_errors_hold_the_extension_keys():
    params = recorded()
    assert tools.params_errors(params) == []
    assert tools.params_errors({**params, "reserved_ip": " "}) == ["compute state carries no reserved_ip"]
    assert tools.params_errors({k: v for k, v in params.items() if k != "vpc_id"}) == \
        ["compute state carries no vpc_id"]
    assert tools.params_errors({**params, "vpc_ip_range": None}) == \
        ["compute state carries no vpc_ip_range"]
    assert tools.params_errors({**params, "vpc_ip_range": "10.110.0.1/20"}) == \
        ['compute state vpc_ip_range "10.110.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']
    nodes = params["nodes"]
    damaged = [nodes[0], {k: v for k, v in nodes[1].items() if k != "droplet_id"},
               {**nodes[2], "droplet_id": ""}]
    assert tools.params_errors({**params, "nodes": damaged}) == \
        ["compute state carries no droplet_id for 1, 2"]


async def test_load_infrastructure_adopts_the_state_preflight_handed_on():
    params = recorded()

    async def load(event, state):
        return await tools.load_infrastructure_step(
            fixture({"blue/event": event, "mysql-ha/state": state}))

    # A recorded cluster.
    r = await load("delete", {"params": params})
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert r["mysql-ha/infrastructure-present?"] is True
    assert "mysql-ha/state" not in r
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.11", "203.0.113.12", "203.0.113.13"]
    # A readable state that records no cluster.
    r = await load("delete", {"params": None})
    assert r["blue/exit"] == 0
    assert r["mysql-ha/infrastructure-present?"] is False
    assert "once/cluster" not in r
    # The cleanup has nothing to reach and skips itself.
    assert (await tools.cleanup_step(r))["blue/exit"] == 0
    r = await load("health", {"params": None})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == tools.NO_CLUSTER_MESSAGE
    # An unreadable backend fails closed.
    r = await load("delete", {"error": "tofu output failed: no backend"})
    assert r["blue/exit"] == 1
    assert "could not read the infrastructure state for the delete cleanup" in r["blue/err"]
    assert "no backend" in r["blue/err"]
    assert "could not read the infrastructure state for health" in \
        (await load("health", {"error": "x"}))["blue/err"]
    # A partial cluster is refused with ONCE's message.
    r = await load("delete", {"params": {**params, "nodes": params["nodes"][:2]}})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    # An adopted cluster without its extension keys is refused.
    r = await load("delete", {"params": {k: v for k, v in params.items() if k != "vpc_id"}})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no vpc_id"


def test_a_real_create_resolves_the_cluster_from_the_apply():
    # The apply's `params` output is what every later stage reads; never the
    # fallbacks.
    params = recorded()
    opts = fixture({"blue/event": "create"})

    def apply(p):
        result = {**opts, "blue/exit": 0}
        if p is not None:
            result["mysql-ha/outputs"] = {"params": p}
        return tools.resolve_infrastructure(opts, result)

    r = apply(params)
    assert r["blue/exit"] == 0
    assert r["once/cluster"] == params
    assert [n["public-ip"] for n in tools.nodes(r)] == ["203.0.113.11", "203.0.113.12", "203.0.113.13"]
    r = apply(None)
    assert r["blue/exit"] == 1
    assert r["blue/err"] == cluster.NO_PARAMS_MESSAGE
    r = apply({**params, "nodes": params["nodes"][:2]})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "the compute stage did not report nodes this package declares: 2"
    r = apply({**params, "nodes": [{k: v for k, v in n.items() if k != "droplet_id"}
                                   for n in params["nodes"]]})
    assert r["blue/exit"] == 1
    assert r["blue/err"] == "compute state carries no droplet_id for 0, 1, 2"
    # A failed apply, a delete and a build hand the result on untouched.
    assert tools.resolve_infrastructure(opts, {**opts, "blue/exit": 1, "blue/err": "apply failed"})["blue/exit"] == 1
    assert "once/cluster" not in tools.resolve_infrastructure(
        {**opts, "blue/event": "build"}, {**opts, "blue/exit": 0})
    assert tools.resolve_infrastructure(
        {**opts, "blue/event": "delete"}, {**opts, "blue/exit": 0})["blue/exit"] == 0


def test_the_inventory_names_both_groups():
    inv = json.loads(tools.inventory(fixture()))
    children = inv["all"]["children"]
    assert len(children["mysql"]["hosts"]) == 3
    assert list(children["bootstrap"]["hosts"]) == ["fixture-node-1"]
    # Bootstrap is only ever member one, and only for an empty group.
    assert children["bootstrap"]["hosts"]["fixture-node-1"] == \
        children["mysql"]["hosts"]["fixture-node-1"]
    # The members are reached with the generated key in keygen mode, on a
    # build through the placeholder, and with the operator's own key in
    # opt-out mode.
    built = json.loads(tools.inventory(fixture({"blue/event": "build"})))
    assert built["all"]["children"]["mysql"]["hosts"]["fixture-node-2"][
        "ansible_ssh_private_key_file"] == "/home/build-placeholder/.ssh/mysql-ha-fixture"
    opted_out = json.loads(tools.inventory(optout()))
    assert opted_out["all"]["children"]["mysql"]["hosts"]["fixture-node-2"][
        "ansible_ssh_private_key_file"] == "~/.ssh/id_ed25519"


def test_the_local_stage_writes_one_block_per_alias_and_carries_no_address():
    data = tools.ansible_local_specs(fixture())[0]["data"]
    assert data["ssh-keygen"] is True
    assert data["ssh-config-identity-file"] == "~/.ssh/mysql-ha-fixture"
    assert data["host-alias"] == "mysql-ha-fixture"
    # Addresses travel as extra-vars, never through Selmer.
    assert "ssh_hosts" not in data
    assert tools.ansible_local_specs(optout())[0]["data"]["ssh-keygen"] is False
    # The bare alias points at member one, then one alias per member.
    assert tools.ssh_config_hosts(fixture()) == [
        {"name": "mysql-ha-fixture", "ip": "192.0.2.11"},
        {"name": "mysql-ha-fixture-0", "ip": "192.0.2.11"},
        {"name": "mysql-ha-fixture-1", "ip": "192.0.2.12"},
        {"name": "mysql-ha-fixture-2", "ip": "192.0.2.13"}]


async def test_a_delete_whose_state_records_no_cluster_has_no_block_to_withdraw():
    r = await tools.ansible_local_step(
        fixture({"blue/event": "delete", "mysql-ha/infrastructure-present?": False}))
    assert r["blue/exit"] == 0


def test_the_inventory_is_byte_stable():
    assert tools.inventory(fixture()) == tools.inventory(fixture())


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


def test_the_source_lists_reach_the_template_as_json_lists():
    data = tools.infrastructure_specs(fixture())[0]["data"]
    assert data["digitalocean-ssh-sources-json"] == '["203.0.113.7/32"]'
    # An overlay string renders the same list.
    data = tools.infrastructure_specs(
        fixture({"digitalocean-client-sources": "203.0.113.7/32, 198.51.100.0/24"}))[0]["data"]
    assert data["digitalocean-client-sources-json"] == '["203.0.113.7/32","198.51.100.0/24"]'


def test_the_backup_prefix_never_carries_a_trailing_slash():
    assert utils.backup_prefix(fixture()) == "mysql-ha-fixture"
    assert utils.backup_prefix({"backup-r2-prefix": "a/b//"}) == "a/b"
