"""OpenTofu and Ansible stages for the three-member Group Replication cluster —
the port of io.github.getcolors.mysql-ha.tools.

Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
One Ansible directory holds every playbook, because they share an inventory
and a set of rendered scripts and splitting them across directories would
duplicate both.

The cluster itself — which machines exist, at which addresses — is the
Compute Cluster Standard's `params`, adopted through ONCE's `compute_cluster`
module and carried under `once/cluster`. This package puts its own facts
inside it: `reserved_ip`, `vpc_id` and `vpc_ip_range` at the top level, a
`droplet_id` on every node.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_step, ansible_with_spec
from blue.providers import tool_env
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed
from package_once_blue import compute as once_compute
from package_once_blue import compute_cluster as cluster

from . import ssh, ssh_config, utils, validate

infrastructure_tool = "mysql-ha-infrastructure"
dns_tool = "mysql-ha-dns"
ansible_local_tool = "mysql-ha-ansible-local"
ansible_tool = "mysql-ha-ansible"
tofu_tools = [infrastructure_tool, dns_tool]

ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def template(path: str, file: str) -> dict:
    name = f"tools/{path.replace('.', '/')}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def tool_dir(opts: dict, tool: str) -> str:
    return utils.tool_dir(opts, tool)


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    return tool_env(validate.providers, opts, [*slots, "provider-backend"])


def backend_advice(tool: str):
    """The state backend of one OpenTofu stage, written before the stage
    runs. `dir` and `key` are explicit so the state addresses cannot move."""
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


def _refuse(opts: dict, errors: list[str]) -> dict:
    return {**opts, "blue/exit": 1, "blue/err": "\n".join(errors)}


def _compact_json(value) -> str:
    """Cheshire's non-pretty generate-string: no whitespace at all."""
    return json.dumps(value, separators=(",", ":"))


# ---------------------------------------------------------------------------
# infrastructure

# Stand-ins for the cluster facts beside the nodes, so `build` and `--dry-run`
# render the same shape of file as a real run without ever reading state or
# contacting a provider. Documentation-range values, so a rendered artifact
# that leaked into a real run would fail loudly rather than reach something.
# The nodes themselves are ONCE's fallbacks, cut from `spec`'s subnet at
# offset 11.
fallback_outputs = {
    "reserved_ip": "192.0.2.10",
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.110.0.0/20",
}


def _fallback_droplet_id(ordinal: int) -> int:
    """The droplet id a build renders for member `ordinal`; a real run reads
    every id from state."""
    return 100000000 + ordinal


def infrastructure_specs(opts: dict) -> list[dict]:
    # The machine-key paths are filled here as well as in preflight, so the
    # template renders the same bytes whichever step scaffolds it — the state
    # reader renders it as a build, and a test may render it alone.
    opts = ssh.with_machine_key(opts)
    dir = tool_dir(opts, infrastructure_tool)
    data = {**opts,
            "node-count": utils.node_count(opts),
            "digitalocean-ssh-sources-json":
                _compact_json(once_compute.cidrs(opts, "digitalocean-ssh-sources")),
            "digitalocean-client-sources-json":
                _compact_json(once_compute.cidrs(opts, "digitalocean-client-sources"))}
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data)]


def output_params(result: dict) -> dict | None:
    """The compute stage's `params` output, as ONCE reads it; None when the
    apply reported none."""
    return cluster.output_params({"tofu/outputs": result.get("mysql-ha/outputs")})


def _non_blank(v) -> bool:
    return ((isinstance(v, int) and not isinstance(v, bool))
            or (isinstance(v, str) and v.strip() != ""))


def params_errors(params: dict) -> list[str]:
    """The extension keys this package puts inside `params`, which ONCE
    preserves but does not read: a non-blank `reserved_ip` and `vpc_id`, a
    canonical `vpc_ip_range`, and a non-blank `droplet_id` on every node. A
    real run is refused without them; the legacy translation is held to the
    same rule."""
    errors: list[str] = []
    for k in ["reserved_ip", "vpc_id"]:
        if not _non_blank(params.get(k)):
            errors.append(f"compute state carries no {k}")
    if not _non_blank(params.get("vpc_ip_range")):
        errors.append("compute state carries no vpc_ip_range")
    elif not cluster.ipv4_network(params.get("vpc_ip_range")):
        errors.append(f"compute state vpc_ip_range {json.dumps(params.get('vpc_ip_range'))}"
                      " is not a canonical IPv4 network such as 10.40.0.0/24")
    missing = [cluster.node_id_str(n) for n in (params.get("nodes") or [])
               if not _non_blank(n.get("droplet_id"))]
    if missing:
        errors.append(f"compute state carries no droplet_id for {', '.join(missing)}")
    return errors


def _checked(opts: dict) -> dict:
    """`opts` once the adopted cluster passes `params_errors`, or the refusal."""
    errors = params_errors(opts["once/cluster"]) if "once/cluster" in opts else []
    return _refuse(opts, errors) if errors else opts


def resolve_infrastructure(opts: dict, result: dict) -> dict:
    """What the infrastructure stage hands on after its apply: `result` as it
    is on a failure, a delete or a build, and otherwise ONCE's
    `resolved_cluster` over the apply's `params` output — None outputs and a
    partial cluster are refused there — checked against `params_errors`.
    Pure, so the wiring is testable without an apply."""
    if failed(result):
        return result
    if opts.get("blue/event") in ("delete", "build"):
        return result
    resolved = cluster.resolved_cluster(validate.spec, opts, result, {}, output_params(result))
    return resolved if failed(resolved) else _checked(resolved)


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="mysql-ha/outputs")
    return resolve_infrastructure(opts, result)


def legacy_params(opts: dict, outputs: dict) -> dict:
    """A state written before this package recorded `params`: the parallel
    `node_public_ips`, `node_private_ips` and `node_droplet_ids` lists,
    zipped into the nodes the standard describes, with `reserved_ip`,
    `vpc_id` and `vpc_ip_range` copied and the names this package has always
    given its members. Refused, as the SDK's `StepError`, when the three
    lists disagree with each other or with `cluster-nodes` — guessing which
    droplet is which is how a delete destroys around a member — and when no
    `reserved_ip` was recorded. A missing `vpc_id` or `vpc_ip_range` is
    `params_errors`' to refuse, the same way for a legacy and a recorded
    state."""
    def as_list(v) -> list:
        return list(v) if isinstance(v, (list, tuple)) else []

    publics = as_list(outputs.get("node_public_ips"))
    privates = as_list(outputs.get("node_private_ips"))
    ids = as_list(outputs.get("node_droplet_ids"))
    n = opts.get("cluster-nodes")
    if not (n == len(publics) == len(privates) == len(ids)):
        raise StepError(f"legacy state lists {len(publics)} public addresses, "
                        f"{len(privates)} private addresses and {len(ids)} droplet ids; "
                        "refusing to guess the cluster")
    if not _non_blank(outputs.get("reserved_ip")):
        raise StepError("legacy state carries no reserved_ip")
    return {"provider": validate.default_compute_provider,
            "reserved_ip": outputs.get("reserved_ip"),
            "vpc_id": outputs.get("vpc_id"),
            "vpc_ip_range": outputs.get("vpc_ip_range"),
            "nodes": [{"index": i,
                       "role": None,
                       "name": utils.node_name(opts, i + 1),
                       "ip": publics[i],
                       "vpc_ip": privates[i],
                       "droplet_id": ids[i],
                       "user": "root",
                       "sudoer": "root"}
                      for i in range(n)]}


async def state_output(opts: dict) -> dict | None:
    """The reader ONCE's `read_state` takes: the compute `params` recorded in
    the infrastructure state, None when the state is readable and holds
    nothing, and the legacy translation when it holds only the pre-adoption
    outputs. Delete and health both need the cluster and neither can
    re-derive it — nor can a fresh clone, so the stage is rendered, its
    backend written and initialized here, before the read. A failed
    initialization raises the SDK's `StepError`, the shape `blue.tofu`
    raises on an unreadable backend; `read_state` reports both fail-closed.
    Kept local, and looked up on this module at call time, so tests can
    replace it."""
    dir = tool_dir(opts, infrastructure_tool)
    env = credential_env(opts, "provider-compute")
    scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts))
    backend_advice(infrastructure_tool)(opts)
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"], env=env)
    if init.exit != 0:
        raise StepError("infrastructure state initialization failed: "
                        f"{init.err or init.out or '(no output)'}")
    outputs = await tofu.outputs(dir, env)
    if "params" in outputs:
        return outputs["params"]
    if not outputs:
        return None
    return legacy_params(opts, outputs)


# The health refusal when the state is readable and records no cluster: a
# real run never checks the documentation addresses.
NO_CLUSTER_MESSAGE = ("the infrastructure state records no cluster; "
                      "refusing to check the documentation addresses")


async def load_infrastructure_step(opts: dict) -> dict:
    """Adopt the cluster out of remote state without planning or changing
    anything: ONCE's `adopt_state` over the read `start_step` handed on
    under `mysql-ha/state`, or a fresh read when nothing was. An unreadable
    backend and a partial cluster fail closed; the adopted `params` must
    then pass `params_errors`. A readable state without a cluster means
    there is nothing to clean up on a delete and nothing to check on a
    health."""
    event = str(opts.get("blue/event"))
    if "mysql-ha/state" in opts:
        state = opts["mysql-ha/state"]
    else:
        state = await cluster.read_state(opts, state_output)
    handed = {k: v for k, v in opts.items() if k != "mysql-ha/state"}
    adopted = cluster.adopt_state(validate.spec, handed, event, state)
    present = "once/cluster" in adopted
    if failed(adopted):
        return adopted
    if not present and event == "health":
        return _refuse(adopted, [NO_CLUSTER_MESSAGE])
    checked = _checked(adopted)
    if failed(checked):
        return checked
    return {**checked, "mysql-ha/infrastructure-present?": present}


# ---------------------------------------------------------------------------
# shared template data

def _cluster_nodes(opts: dict) -> list[dict]:
    """ONCE's nodes for this deployment: the adopted `params.nodes` on a real
    run, the fallbacks on a build — renamed to what this package has always
    called its members and given a documentation droplet id, so the rendered
    inventory is byte-identical to what it was."""
    params = opts.get("once/cluster")
    nodes = cluster.nodes(validate.spec, opts, params)
    if params is not None:
        return list(nodes)
    return [{**node,
             "name": utils.node_name(opts, node["index"] + 1),
             "droplet_id": _fallback_droplet_id(node["index"] + 1)}
            for node in nodes]


def nodes(opts: dict) -> list[dict]:
    """One map per member, in ordinal order: desired state's derivations over
    the node ONCE reports. Pure: given the same opts it is the same list,
    which is what makes the inventory and the goldens deterministic."""
    members = []
    for node in _cluster_nodes(opts):
        ordinal = node["index"] + 1
        members.append({"ordinal": ordinal,
                        "name": node.get("name"),
                        "host": utils.node_host(opts, ordinal),
                        "public-ip": node.get("ip"),
                        "private-ip": node.get("vpc_ip"),
                        "droplet-id": node.get("droplet_id"),
                        "server-id": utils.server_id(ordinal),
                        "connection-server-id": utils.connection_server_id(ordinal)})
    return members


def group_seeds(opts: dict) -> str:
    """`group_replication_group_seeds`: every member's private address on the
    group port. Every member gets the same list, so a joining member can reach
    the group through whichever seed is up."""
    return ",".join(f"{node['private-ip']}:{opts.get('mysql-group-port')}"
                    for node in nodes(opts))


def private_key_file(data: dict) -> str:
    """The private key every play reaches the members with: the generated
    key's path in keygen mode (the build placeholder on a build or a dry-run),
    the operator's `digitalocean-ssh-private-key` in opt-out mode."""
    if validate.keygen(data):
        return str(data.get("ssh-private-key-path"))
    return str(data.get("digitalocean-ssh-private-key"))


def data_fn(opts: dict) -> dict:
    """Template data: desired state over the fallback cluster facts, with the
    adopted cluster's `reserved_ip`, `vpc_id` and `vpc_ip_range` winning on a
    real run, and the machine-key paths keygen mode owns."""
    opts = ssh.with_machine_key(opts)
    recorded = opts.get("once/cluster") or {}
    facts = {k: recorded[k] for k in fallback_outputs if k in recorded}
    data = {**fallback_outputs, **opts, **facts}
    return {**data,
            "node-count": utils.node_count(opts),
            "backup-prefix": utils.backup_prefix(opts),
            "group-seeds": group_seeds(data),
            "cluster-record": utils.record_name(opts.get("cluster-host"))}


def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Green's cheshire JSON emits for
    floats: decimal between 1e-3 and 1e7, `d.dddE±e` scientific outside it.
    Python's own repr disagrees exactly where scientific notation starts
    (0.0001 -> "1.0E-4"), and the goldens carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


def inventory(opts: dict) -> str:
    """Ansible inventory as JSON. Every member is in `mysql`; `bootstrap`
    holds member one, which is only ever used to pick who bootstraps an empty
    group — it carries no meaning once the group exists."""
    data = data_fn(opts)
    key_file = private_key_file(data)
    members = nodes(data)
    hosts = {node["name"]: {
        # Key order matches green's sorted-map: alphabetical.
        "ansible_host": node["public-ip"],
        "ansible_ssh_private_key_file": key_file,
        "ansible_user": "root",
        "connection_server_id": node["connection-server-id"],
        "droplet_id": node["droplet-id"],
        "node_host": node["host"],
        "node_ordinal": node["ordinal"],
        "private_ip": node["private-ip"],
        "server_id": node["server-id"],
    } for node in sorted(members, key=lambda node: str(node["name"]))}
    bootstrap_name = members[0]["name"] if members else None
    bootstrap = ({bootstrap_name: hosts[bootstrap_name]}
                 if bootstrap_name in hosts else {})
    return _pretty(
        {"all": {"children": {"mysql": {"hosts": hosts},
                              "bootstrap": {"hosts": bootstrap}}}})


# ---------------------------------------------------------------------------
# ssh config (local)

def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. Addresses are run-time facts and
    reach the play as extra-vars instead, so the rendered playbook carries no
    IP and is identical on every workstation (SSH Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts),
            "host-alias": ssh_config.host_alias(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


def ssh_config_hosts(opts: dict) -> list[dict]:
    """The `~/.ssh/config` entries, as data the play loops over: the bare
    profile pointing at node 0 (the spec's entry), then one alias per member.
    ONCE's (Compute Cluster Standard §6)."""
    return cluster.ssh_config_hosts(validate.spec, opts, _cluster_nodes(opts))


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves
    both events; `block_state` is what distinguishes them. Skipped on a delete
    whose state records no cluster: there is no block to withdraw."""
    delete = opts.get("blue/event") == "delete"
    if delete and opts.get("mysql-ha/infrastructure-present?") is False:
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=tool_dir(opts, ansible_local_tool), inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ssh_hosts": ssh_config_hosts(opts),
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------------------
# dns

def dns_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, dns_tool)
    base = data_fn(opts)
    records = {utils.record_name(node["host"]): node["public-ip"]
               for node in sorted(nodes(base),
                                  key=lambda node: utils.record_name(node["host"]))}
    data = {**base, "node-records-json": _compact_json(records)}
    return [spec(template("dns", "main.tf"), f"{dir}/main.tf", data)]


async def dns_step(opts: dict) -> dict:
    return await tofu.tofu_with_spec(
        opts, dns_specs(opts),
        dir=tool_dir(opts, dns_tool),
        env=credential_env(opts, "provider-dns"),
        output_key="mysql-ha/dns-outputs")


# ---------------------------------------------------------------------------
# ansible

_playbooks = ["base.yml", "cluster.yml", "backup.yml", "health.yml", "cleanup.yml"]

# Everything copied onto a member. Credentials are deliberately absent: the
# three files that hold one (`rclone.conf`, `binlog-client.cnf`,
# `secrets.env`) are written by Ansible from `lookup('env', ...)` under
# `no_log`, so no secret is ever rendered into the work directory.
_node_files = [
    "mysql-ha-lib", "mysql-ha-endpoint", "mysql-ha-heartbeat", "mysql-ha-snapshot",
    "mysql-ha-binlog-archive", "mysql-ha-binlog-upload", "mysql-ha-restore-check",
    "mysql-ha-health", "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = data_fn(opts)
    return [spec(template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            *[spec(template("ansible", playbook), f"{dir}/{playbook}", data)
              for playbook in _playbooks],
            *[spec(template("ansible.files", file), f"{dir}/files/{file}", data)
              for file in _node_files],
            raw_spec(f"{dir}/inventory.json", inventory(opts))]


def _ansible_config(opts: dict, playbook: str, recap_key: str) -> dict:
    return {"dir": tool_dir(opts, ansible_tool),
            "inventory": "inventory.json",
            "playbooks": {"create": playbook, "delete": playbook},
            "host_key_checking": False,
            "recap_key": recap_key}


def ansible_render_step(opts: dict) -> dict:
    """Render the whole Ansible directory once, so every later stage runs
    against one materialized tree rather than re-rendering per playbook."""
    return scaffold(opts, ansible_specs(opts))


async def _playbook_step(opts: dict, playbook: str, recap_key: str) -> dict:
    if opts.get("blue/event") == "build":
        return scaffold(opts, ansible_specs(opts))
    return await ansible_step(
        scaffold({**opts, "blue/event": "create"}, ansible_specs(opts)),
        **_ansible_config(opts, playbook, recap_key))


async def base_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "base.yml", "mysql-ha/base-recap")),
            "blue/event": opts.get("blue/event")}


async def cluster_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "cluster.yml", "mysql-ha/cluster-recap")),
            "blue/event": opts.get("blue/event")}


async def backup_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "backup.yml", "mysql-ha/backup-recap")),
            "blue/event": opts.get("blue/event")}


async def health_step(opts: dict) -> dict:
    return {**(await _playbook_step(opts, "health.yml", "mysql-ha/health-recap")),
            "blue/event": opts.get("blue/event")}


async def cleanup_step(opts: dict) -> dict:
    """Stop the managed units before the droplets go away. Skipped when the
    infrastructure is already gone, because there is nothing to reach."""
    if opts.get("mysql-ha/infrastructure-present?") is False:
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        **_ansible_config(opts, "cleanup.yml", "mysql-ha/cleanup-recap"))
