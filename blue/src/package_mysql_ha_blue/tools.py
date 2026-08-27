"""OpenTofu and Ansible stages for the three-member Group Replication cluster —
the port of io.github.getcolors.mysql-ha.tools.

Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
One Ansible directory holds every playbook, because they share an inventory
and a set of rendered scripts and splitting them across directories would
duplicate both.
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
from blue.workflow import failed

from . import utils, validate

infrastructure_tool = "mysql-ha-infrastructure"
dns_tool = "mysql-ha-dns"
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


def _compact_json(value) -> str:
    """Cheshire's non-pretty generate-string: no whitespace at all."""
    return json.dumps(value, separators=(",", ":"))


# ---------------------------------------------------------------------------
# infrastructure

# Stand-ins so `build` and `--dry-run` render the same shape of file as a real
# run, without ever reading state or contacting a provider. Documentation-range
# addresses, so a rendered artifact that leaked into a real run would fail
# loudly rather than reach something.
fallback_outputs = {
    "node_public_ips": ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
    "node_private_ips": ["10.110.0.11", "10.110.0.12", "10.110.0.13"],
    "node_droplet_ids": [100000001, 100000002, 100000003],
    "reserved_ip": "192.0.2.10",
    "vpc_id": "00000000-0000-0000-0000-000000000000",
    "vpc_ip_range": "10.110.0.0/20",
}


def infrastructure_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, infrastructure_tool)
    data = {**opts,
            "node-count": utils.node_count(opts),
            "digitalocean-ssh-sources-json":
                _compact_json(opts.get("digitalocean-ssh-sources")),
            "digitalocean-client-sources-json":
                _compact_json(opts.get("digitalocean-client-sources"))}
    return [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data)]


def _outputs_map(result: dict) -> dict:
    return result.get("mysql-ha/outputs") or {}


async def infrastructure_step(opts: dict) -> dict:
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=tool_dir(opts, infrastructure_tool),
        env=credential_env(opts, "provider-compute"),
        output_key="mysql-ha/outputs")
    if failed(result):
        return result
    if opts.get("blue/event") == "delete":
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_outputs}
    return {**result, **fallback_outputs, **_outputs_map(result)}


def process_result(opts: dict, label: str, res) -> dict:
    if res.exit == 0:
        return {**opts, "blue/exit": 0}
    return {**opts,
            "blue/exit": max(1, res.exit),
            "blue/err": f"{label} failed: {res.err or res.out or '(no output)'}"}


async def load_infrastructure_step(opts: dict) -> dict:
    """Read node addresses out of remote state without planning or changing
    anything. Delete and health both need the inventory and neither can
    re-derive it; `k8s` needs the same thing for the same reason."""
    dir = tool_dir(opts, infrastructure_tool)
    rendered = {**scaffold({**opts, "blue/event": "build"}, infrastructure_specs(opts)),
                "blue/event": opts.get("blue/event")}
    env = credential_env(opts, "provider-compute")
    init = await runtime.exec(
        ["tofu", f"-chdir={dir}", "init", "-input=false", "-no-color"], env=env)
    if init.exit != 0:
        return process_result(rendered, "infrastructure state initialization", init)
    try:
        outputs = await tofu.outputs(dir, env)
        return {**rendered, **fallback_outputs, **outputs,
                "mysql-ha/infrastructure-present?": "reserved_ip" in outputs}
    except Exception as t:  # noqa: BLE001 — mirror green's Throwable catch
        message = str(t) or type(t).__name__
        return {**rendered, "blue/exit": 1,
                "blue/err": f"infrastructure state output failed: {message}"}


# ---------------------------------------------------------------------------
# shared template data

def nodes(opts: dict) -> list[dict]:
    """One map per member, in ordinal order, merging desired state with
    whatever the infrastructure stage reported. Pure: given the same opts it
    is the same vector, which is what makes the inventory and the goldens
    deterministic."""
    data = {**fallback_outputs, **opts}

    def nth(key: str, idx: int):
        values = data.get(key)
        return values[idx] if isinstance(values, (list, tuple)) and idx < len(values) else None

    return [{"ordinal": ordinal,
             "name": utils.node_name(opts, ordinal),
             "host": utils.node_host(opts, ordinal),
             "public-ip": nth("node_public_ips", ordinal - 1),
             "private-ip": nth("node_private_ips", ordinal - 1),
             "droplet-id": nth("node_droplet_ids", ordinal - 1),
             "server-id": utils.server_id(ordinal),
             "connection-server-id": utils.connection_server_id(ordinal)}
            for ordinal in utils.ordinals(opts)]


def group_seeds(opts: dict) -> str:
    """`group_replication_group_seeds`: every member's private address on the
    group port. Every member gets the same list, so a joining member can reach
    the group through whichever seed is up."""
    return ",".join(f"{node['private-ip']}:{opts.get('mysql-group-port')}"
                    for node in nodes(opts))


def data_fn(opts: dict) -> dict:
    data = {**fallback_outputs, **opts}
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
    key_file = str(data.get("digitalocean-ssh-private-key"))
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
    } for node in sorted(nodes(data), key=lambda node: str(node["name"]))}
    bootstrap_name = utils.node_name(opts, 1)
    bootstrap = ({bootstrap_name: hosts[bootstrap_name]}
                 if bootstrap_name in hosts else {})
    return _pretty(
        {"all": {"children": {"mysql": {"hosts": hosts},
                              "bootstrap": {"hosts": bootstrap}}}})


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
