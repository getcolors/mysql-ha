"""Launcher contract, node topology, and the small derivations several
modules share — the port of io.github.getcolors.mysql-ha.utils.

The topology is a pure function of desired state: three homogeneous members
numbered from one. Nothing here reaches a network, so tests can assert the
whole shape of the cluster without provisioning anything.
"""

from __future__ import annotations

import re

from blue.cli import stage_dir

# Minimum mysql-ha contract a standalone launcher must find. Bump on any
# change a launcher pinned to an older commit could not survive.
CONTRACT = 1


def node_count(opts: dict) -> int:
    n = opts.get("cluster-nodes")
    return n if isinstance(n, int) and not isinstance(n, bool) else 3


def ordinals(opts: dict) -> list[int]:
    return list(range(1, node_count(opts) + 1))


def node_name(opts: dict, ordinal: int) -> str:
    """The DigitalOcean droplet name for member `ordinal`, and the Ansible
    inventory host alias. One name, so a droplet in the console and a host in
    a play recap are obviously the same thing."""
    return f"{opts.get('digitalocean-name')}-node-{ordinal}"


def node_names(opts: dict) -> list[str]:
    return [node_name(opts, ordinal) for ordinal in ordinals(opts)]


def server_id(ordinal: int) -> int:
    """MySQL `server_id`. Distinct per member and stable across rebuilds,
    because it is derived from the ordinal rather than from an address."""
    return 100 + ordinal


def connection_server_id(ordinal: int) -> int:
    """The pseudo-replica id `mysqlbinlog --read-from-remote-server` registers
    with. It must not collide with any real member's `server_id`."""
    return 200 + ordinal


def node_host(opts: dict, ordinal: int) -> str:
    """`node-2.my-ha.bigconfig.space` — the per-member administrative name.
    The cluster host itself always points at the reserved IP, never at a
    member."""
    return f"node-{ordinal}.{opts.get('cluster-host')}"


def record_name(host) -> str:
    """The Cloudflare record name relative to nothing — Cloudflare 5.x takes
    the fully qualified name, so this is the FQDN with the trailing dot
    removed."""
    return re.sub(r"\.$", "", "" if host is None else str(host))


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="mysql-ha")


def backup_prefix(opts: dict) -> str:
    """Object-key prefix inside the backup bucket, without a trailing slash."""
    value = opts.get("backup-r2-prefix")
    return re.sub(r"/+$", "", "" if value is None else str(value))


_DURATION_RE = re.compile(r"^[0-9]+(?:ms|s|m|h|min|d)$")


def duration(x) -> bool:
    return isinstance(x, str) and bool(_DURATION_RE.fullmatch(x))
