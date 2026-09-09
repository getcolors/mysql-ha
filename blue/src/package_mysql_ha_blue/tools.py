"""Application facts derived from the shared compute library."""

from __future__ import annotations

import json
import math
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_step, ansible_with_spec
from blue.providers import tool_env
from package_once_blue.validate import providers as once_backends
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from blue.workflow import StepError, failed
from colors_compute.orchestration import orchestrate
from colors_compute.planning import plan_deployment
from colors_compute.inspection import read_deployment

from . import compute, ssh, ssh_config, utils, validate

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
    return tool_env({**validate.providers, "provider-backend": once_backends["provider-backend"]}, opts, [*slots, "provider-backend"])


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
async def infrastructure_step(opts):
    planning = opts.get('blue/event') == 'build' or opts.get('blue/dry-run')
    result = plan_deployment(opts, compute.topology(opts), compute.requirements(opts)) if planning else await orchestrate(opts, compute.topology(opts), compute.requirements(opts))
    if result['status'] not in ('planned', 'ready', 'destroyed'):
        return _refuse(opts, ['compute lifecycle refused; legacy monolithic state requires explicit migration'])
    if planning:
        directory = Path(tool_dir(opts, infrastructure_tool))
        for stage, documents in [('shared', result['documents']['shared']), *[(f'nodes/{node}', docs) for node, docs in result['documents']['nodes'].items()]]:
            for name, document in documents.items():
                path = directory / stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(document, sort_keys=True, indent=2) + '\n')
    result_opts = {**opts, 'blue/exit': 0}
    if 'cluster' in result:
        result_opts['colors-compute/cluster'] = result['cluster']
        result_opts['colors-compute/shared'] = result.get('shared', {})
    path = result.get('key', {}).get('private_key_path')
    if path:
        result_opts['ssh-private-key-path'] = path.replace('$HOME/.ssh', '/home/build-placeholder/.ssh') if planning else path
    return result_opts


async def load_infrastructure_step(opts):
    if opts.get('blue/event') == 'build' or opts.get('blue/dry-run'):
        return await infrastructure_step(opts)
    result = await read_deployment(opts)
    if result['status'] == 'destroyed' and opts.get('blue/event') == 'delete':
        return {**opts, 'mysql-ha/already-destroyed': True, 'blue/exit': 0}
    if result['status'] != 'present':
        return _refuse(opts, ['compute state unavailable; legacy monolithic state requires explicit migration'])
    handed = {**opts, 'colors-compute/cluster': result['cluster'], 'colors-compute/shared': result.get('shared', {}), 'mysql-ha/infrastructure-present?': True, 'blue/exit': 0}
    path = result.get('key', {}).get('private_key_path')
    if path:
        handed['ssh-private-key-path'] = path
    return handed


def _cluster_nodes(opts):
    return compute.resolved(opts)


def nodes(opts: dict) -> list[dict]:
    """Application facts derived from the shared compute library."""
    members = []
    for node in _cluster_nodes(opts):
        if not node.get('provider_id'):
            raise ValueError('compute provider identity unavailable')
        ordinal = node["index"] + 1
        members.append({"ordinal": ordinal,
                        "name": node.get("name"),
                        "host": utils.node_host(opts, ordinal),
                        "public-ip": node.get("ip"),
                        "private-ip": node.get("vpc_ip"),
                        "uid": node.get('provider_id'),
                        "user": node["user"],
                        "server-id": utils.server_id(ordinal),
                        "connection-server-id": utils.connection_server_id(ordinal)})
    return members


def group_seeds(opts: dict) -> str:
    """`group_replication_group_seeds`: every member's private address on the
    group port. Every member gets the same list, so a joining member can reach
    the group through whichever seed is up."""
    return ",".join(f"{node['private-ip']}:{opts.get('mysql-group-port')}"
                    for node in nodes(opts))


def private_key_file(data):
    return data.get('ssh-private-key-path') or ''


def data_fn(opts):
    opts = ssh.with_machine_key(opts)
    shared = opts.get('colors-compute/shared')
    if shared is None and (opts.get('blue/event') == 'build' or opts.get('blue/dry-run')):
        shared = plan_deployment(opts, compute.topology(opts), compute.requirements(opts)).get('shared', {})
    facts = (shared or {}).get('params', {})
    if not facts.get('network_cidr') or not facts.get('endpoint_ip'):
        raise ValueError('compute shared network or reserved endpoint unavailable')
    from colors_compute.endpoint import endpoint_agent
    agent = endpoint_agent(opts['provider-compute'])
    data = {**opts, 'endpoint-credentials': agent['credentials'], 'vpc_ip_range': facts['network_cidr'], 'reserved_ip': facts['endpoint_ip']}
    return {**data, 'node-count': utils.node_count(opts), 'backup-prefix': utils.backup_prefix(opts),
            'group-seeds': group_seeds(data), 'cluster-record': utils.record_name(opts.get('cluster-host'))}


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
        "ansible_user": node["user"],
        "connection_server_id": node["connection-server-id"],
        "node_host": node["host"],
        "node_ordinal": node["ordinal"],
        "node_uid": node["uid"],
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
            "ssh-keygen": validate.keygen(opts) or bool(opts.get("ssh-private-key-path")),
            "ssh-config-identity-file": ssh_config.identity_file(opts) if validate.keygen(opts) else opts.get("ssh-private-key-path", ""),
            "host-alias": ssh_config.host_alias(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


def ssh_config_hosts(opts: dict) -> list[dict]:
    """Application facts derived from the shared compute library."""
    ns = _cluster_nodes(opts)
    return [{**ns[0], 'name': opts['profile']}, *[{**node, 'name': opts['profile'] + '-' + node['node_id']} for node in ns]]


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


def _endpoint_agent(opts):
    from colors_compute.endpoint import endpoint_agent
    return endpoint_agent(opts['provider-compute'])


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = data_fn(opts)
    return [spec(template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            *[spec(template("ansible", playbook), f"{dir}/{playbook}", data)
              for playbook in _playbooks],
            *[spec(template("ansible.files", file), f"{dir}/files/{file}", data)
              for file in _node_files],
            raw_spec(f"{dir}/files/colors-compute-endpoint", _endpoint_agent(opts)["content"]),
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
