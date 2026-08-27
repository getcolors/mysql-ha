---
name: package-mysql-ha-red
description: Build and operate a three-member MySQL Group Replication cluster on DigitalOcean with Red — automatic failover onto a reserved IP, daily snapshots and continuous binary-log archiving to Cloudflare R2, and a scheduled verified restore.
license: MIT
---

# MySQL Group Replication on DigitalOcean

Read [references/configuration.md](references/configuration.md) before changing
desired state or running a lifecycle command.

## Safety

- Keep secrets out of `colors.yml`; use ignored `COLORS_PAR_*` exports.
- Never set `COLORS_PAR_PROFILE` and never edit generated `.colors/` files.
- Default to `build` and `create --dry-run`; a real create or delete needs
  explicit authorization.
- Keep `compute-prevent-destroy: true`. Lift it for one authorized delete with
  `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false`.
- Restrict `digitalocean-ssh-sources` and `digitalocean-client-sources`; do not
  use `0.0.0.0/0`. The MySQL port is a public port.
- The design needs exactly two database credentials. Do not introduce a third.

## Commands

```sh
./red build              # render the work directory only
./red create --dry-run   # walk the graph, contact nothing
./red create             # converge, then snapshot, verify a restore, and assert
./red health             # read-only assertions against the live cluster
./red delete             # guarded teardown
```

A real lifecycle run needs Bun, OpenTofu, Ansible and SSH; the shipped
`devenv.nix` supplies them. `build` and `--dry-run` need none of that and no
credential at all.

## What it provisions

Three identical droplets in the region's default VPC (discovered, never
created), one reserved IP, one firewall, and Cloudflare records. On the members:
MySQL 8.0 in single-primary Group Replication, plus six systemd units — the
endpoint claimer, the heartbeat, the binary-log archiver, its uploader, the
snapshot job, and the verified restore.

## How failover works

Group Replication elects the new primary. Separately, a ten-second timer on each
member claims the reserved IP when that member is `ONLINE`, `PRIMARY` and not
`super_read_only`. The Cloudflare record's content is the reserved IP and never
changes, so OpenTofu keeps owning DNS while the cluster owns the assignment.

`digitalocean_reserved_ip` is therefore created **without** `droplet_id`. Adding
it would make every converge after a failover move the endpoint back.

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
