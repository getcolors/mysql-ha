---
name: package-mysql-ha-green
description: Build and operate a three-member MySQL Group Replication cluster with Green — automatic failover onto a reserved IP, daily snapshots and continuous binary-log archiving to Cloudflare R2, and a scheduled verified restore.
license: MIT
---

# MySQL Group Replication

Read [references/configuration.md](references/configuration.md) before changing
desired state or running a lifecycle command.

## Safety

- Keep secrets out of `colors.yml`; use ignored `COLORS_PAR_*` exports.
- Never set `COLORS_PAR_PROFILE` and never edit generated `.colors/` files.
- Default to `build` and `create --dry-run`; a real create or delete needs
  explicit authorization.
- Keep `compute-prevent-destroy: true`. Lift it for one authorized delete with
  `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.
- Restrict `mysql-ssh-sources` and `mysql-client-sources`; do not
  use `0.0.0.0/0`. The MySQL port is a public port.
- The design needs exactly two database credentials. Do not introduce a third.

## Commands

```sh
./green build              # render the work directory only
./green create --dry-run   # walk the graph, contact nothing
./green create             # converge, then snapshot, verify a restore, and assert
./green health             # read-only assertions against the live cluster
./green delete             # guarded teardown
```

A real lifecycle run needs Babashka, OpenTofu, Ansible and SSH; the shipped
`devenv.nix` supplies them. `build` and `--dry-run` need none of that and no
credential at all.

## What it provisions

Three identical machines on a private network, one application-assigned
reserved IP, firewall rules, and Cloudflare records. On the members:
MySQL 8.0 in single-primary Group Replication, plus six systemd units — the
endpoint claimer, the heartbeat, the binary-log archiver, its uploader, the
snapshot job, and the verified restore.

Compute, SSH keys, and remote state are supplied by the pinned
[colors-compute library](https://github.com/getcolors/colors-compute). Select a
provider supported by that revision and configure its options and credentials.
The package supplies three peer nodes and application network requirements;
the library joins observed node addresses and SSH users for Ansible.

Use `provider-backend: r2` or `s3`. R2 requires
`COLORS_PAR_R2_ACCESS_KEY_ID` and `COLORS_PAR_R2_SECRET_ACCESS_KEY`; S3 uses
the ambient AWS credential chain. The library owns managed profile keys, or
uses configured external keys with `ssh-private-key-path`. Existing monolithic
compute state requires explicit migration and is refused by this lifecycle.

This package also requires the library capability for an application-assigned
reserved IP. The library supplies the endpoint agent; MySQL decides when a
member is eligible to claim the address.

## How failover works

Group Replication elects the new primary. Separately, a ten-second timer on each
member claims the reserved IP when that member is `ONLINE`, `PRIMARY` and not
`super_read_only`. The Cloudflare record's content is the reserved IP and never
changes, so OpenTofu keeps owning DNS while the cluster owns the assignment.

The library creates the reserved IP without a node assignment. MySQL retains
assignment ownership across failovers and subsequent infrastructure converges.

## Backups and recovery

`snapshot/` holds a daily GTID-stamped `mysqldump`; `binlog/<member>/` holds
continuously archived binary logs from every member; `restore-check/` holds the
verdict of the daily restore that is actually performed.

Recovery is: load the snapshot (it sets `GTID_PURGED`), then pipe the archived
logs through `mysql`. Replay is idempotent by GTID and needs no position
arithmetic. Full procedure in the repository README.

## Bootstrapping is the dangerous operation

The cluster playbook bootstraps a group only after every member has reported it
can see no ONLINE member anywhere. A member that bootstraps beside a live group
forms a second group of one and the two diverge silently. Do not weaken that
condition.
