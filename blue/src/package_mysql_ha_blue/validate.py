"""The provider registry and the desired-state rules it drives — the port of
io.github.getcolors.mysql-ha.validate.

The registry is package-owned rather than inherited from ONCE: this package
ships its own multi-node DigitalOcean template, so coupling its validation to
ONCE's single-server key set would check for keys no stage here uses and miss
the ones it does. `k8s` made the same call for the same reason.

Two credentials reach MySQL — the admin password and the replication
password — and the design is built to need no third. Nothing in here invents
one.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import json
import re

from blue import providers as provider_ops
from blue.cli import par_name

from . import utils

# Provider slot -> provider name -> what that choice implies.
#
# `required` are non-secret keys a template interpolates. `secrets` arrive
# only through `COLORS_PAR_*`. `tofu-env` is the subset OpenTofu reads
# natively from the process environment, so a credential never has to be
# rendered into a .tf file sitting in the work directory in plaintext.
providers = {
    "provider-compute": {
        "digitalocean": {
            "required": ["digitalocean-name", "digitalocean-region",
                         "digitalocean-size", "digitalocean-image",
                         "digitalocean-ssh-keys", "digitalocean-vpc-mode"],
            "secrets": ["do-token"],
            "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
        },
    },

    "provider-dns": {
        "cloudflare": {
            "required": ["cloudflare-zone"],
            "secrets": ["cloudflare-api-token"],
            "tofu-env": {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"},
        },
    },

    "provider-backend": {
        "local": {"required": [], "secrets": [], "tofu-env": {}},
        "s3": {"required": ["s3-bucket", "s3-region"], "secrets": [], "tofu-env": {}},
        # R2 is S3-compatible, so it authenticates through the AWS chain. Naming
        # the keys in backend.tf.json would also copy them into .terraform/.
        "r2": {
            "required": ["r2-bucket", "r2-endpoint"],
            "secrets": ["r2-access-key-id", "r2-secret-access-key"],
            "tofu-env": {"r2-access-key-id": "AWS_ACCESS_KEY_ID",
                         "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY"},
        },
    },
}

slots = ["provider-compute", "provider-dns", "provider-backend"]

own_required = [
    "profile", "workdir",
    "cluster-host", "cluster-nodes",
    "digitalocean-ssh-private-key", "digitalocean-ssh-sources",
    "digitalocean-client-sources",
    "cloudflare-proxied",
    "mysql-port", "mysql-group-port", "mysql-group-name",
    "mysql-admin-user", "mysql-replication-user",
    "mysql-innodb-buffer-pool-size",
    "backup-r2-bucket", "backup-r2-endpoint", "backup-r2-region", "backup-r2-prefix",
    "backup-snapshot-oncalendar", "backup-restore-check-oncalendar",
    "backup-binlog-upload-interval", "backup-retention-days",
    "backup-restore-max-lag-seconds",
    "heartbeat-interval", "endpoint-poll-interval",
]

# The two database credentials the brief allows, plus the separate R2 key pair
# the nodes use for the backup bucket. The backup key pair is deliberately not
# the state-backend key pair: the state bucket and the backup bucket are
# different blast radii.
own_secrets = [
    "mysql-admin-password", "mysql-replication-password",
    "backup-r2-access-key-id", "backup-r2-secret-access-key",
]


def placeholder(x) -> bool:
    return provider_ops.placeholder(x)


profile_par = par_name("profile")


def env_errors(env: dict) -> list[str]:
    """`COLORS_PAR_PROFILE` keys this deployment's remote state. Overlaying it
    can only point one deployment at another's, so it is refused rather than
    honoured."""
    value = env.get(profile_par)
    if str(value if value is not None else "") != "":
        return [f"{profile_par} is set. mysql-ha takes profile from colors.yml only."]
    return []


def _slot_keys(opts: dict, field: str) -> list[str]:
    return provider_ops.slot_keys(providers, opts, slots, field)


def _missing(opts: dict, keys: list[str]) -> list[str]:
    return provider_ops.missing_keys(opts, keys)


HOST_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
CIDR_RE = re.compile(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}/[0-9]{1,2}$")
BUFFER_POOL_RE = re.compile(r"^[0-9]+[KMG]$")
ONCALENDAR_RE = re.compile(r"^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$")


def _positive_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _pr_str(x) -> str:
    """The way Clojure's pr-str prints the value inside green's messages:
    strings quoted, nil spelled out."""
    return "nil" if x is None else json.dumps(x)


def _cidr_list_errors(opts: dict, k: str) -> list[str]:
    v = opts.get(k)
    if placeholder(v):
        return []
    if not isinstance(v, (list, tuple)):
        return [f":{k} must be a list of CIDRs"]
    if not v:
        return [f":{k} must list at least one CIDR"]
    return [f":{k} entry {_pr_str(c)} is not a CIDR"
            for c in v if not CIDR_RE.fullmatch(str(c))]


def state_errors(opts: dict) -> list[str]:
    """Everything wrong with `opts` that does not depend on a credential.
    Empty means the desired state renders."""
    errors: list[str] = []
    for key in _missing(opts, [*own_required, *_slot_keys(opts, "required")]):
        errors.append(f":{key} is required")
    for slot in slots:
        p = opts.get(slot)
        if not (isinstance(p, str) and p in providers.get(slot, {})):
            errors.append(f"unsupported :{slot} {_pr_str(p)}")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    if not isinstance(opts.get("cloudflare-proxied"), bool):
        errors.append(":cloudflare-proxied must be true or false")
    if opts.get("cloudflare-proxied") is True:
        errors.append(":cloudflare-proxied must be false; Cloudflare's proxy does not carry the MySQL protocol")
    if not (placeholder(opts.get("cluster-host"))
            or HOST_RE.fullmatch(str(opts.get("cluster-host")))):
        errors.append(":cluster-host must be a fully qualified hostname")
    if not (placeholder(opts.get("cluster-host"))
            or placeholder(opts.get("cloudflare-zone"))
            or str(opts.get("cluster-host")).endswith(f".{opts.get('cloudflare-zone')}")):
        errors.append(":cluster-host must sit inside :cloudflare-zone")
    if opts.get("cluster-nodes") != 3:
        errors.append(":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets")
    if opts.get("digitalocean-vpc-mode") != "default":
        errors.append(":digitalocean-vpc-mode must be default; the VPC is discovered at run time and is never desired state")
    if not (placeholder(opts.get("mysql-group-name"))
            or UUID_RE.fullmatch(str(opts.get("mysql-group-name")))):
        errors.append(":mysql-group-name must be a UUID; MySQL rejects anything else as a group name")
    for k in ["mysql-port", "mysql-group-port", "backup-retention-days",
              "backup-restore-max-lag-seconds"]:
        if not _positive_int(opts.get(k)):
            errors.append(f":{k} must be a positive integer")
    if opts.get("mysql-port") == opts.get("mysql-group-port"):
        errors.append(":mysql-group-port must differ from :mysql-port")
    if not (placeholder(opts.get("mysql-innodb-buffer-pool-size"))
            or BUFFER_POOL_RE.fullmatch(str(opts.get("mysql-innodb-buffer-pool-size")))):
        errors.append(":mysql-innodb-buffer-pool-size must be a size such as 1G")
    for k in ["heartbeat-interval", "endpoint-poll-interval",
              "backup-binlog-upload-interval"]:
        if not placeholder(opts.get(k)) and not utils.duration(opts.get(k)):
            errors.append(f":{k} must be a systemd duration such as 10s or 1min")
    for k in ["backup-snapshot-oncalendar", "backup-restore-check-oncalendar"]:
        if not placeholder(opts.get(k)) and not ONCALENDAR_RE.fullmatch(str(opts.get(k))):
            errors.append(f":{k} must be a systemd OnCalendar expression such as *-*-* 01:00:00")
    if (not placeholder(opts.get("backup-r2-bucket"))
            and not placeholder(opts.get("r2-bucket"))
            and str(opts.get("backup-r2-bucket")) == str(opts.get("r2-bucket"))):
        errors.append(":backup-r2-bucket must not be the state bucket")
    errors.extend(_cidr_list_errors(opts, "digitalocean-ssh-sources"))
    errors.extend(_cidr_list_errors(opts, "digitalocean-client-sources"))
    return errors


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real run needs that no `COLORS_PAR_*` variable supplied.

    `health` reads remote state and talks to the nodes over SSH; every MySQL
    query it makes runs on the node against its local socket, so it needs the
    provider credentials and none of the database ones."""
    keys = (_slot_keys(opts, "secrets")
            if opts.get("blue/event") == "health"
            else [*_slot_keys(opts, "secrets"), *own_secrets])
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(_missing(opts, keys))]
