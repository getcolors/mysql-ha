# CLAUDE.md

## What this is

`mysql-ha` is a green-only Package Skill for a three-member MySQL **Group
Replication** cluster on DigitalOcean, with daily snapshots and continuous
binary-log archiving to Cloudflare R2 and a scheduled verified restore. The
consumer is `../mysql-ha-digitalocean`.

Read `plans/0001-mysql-ha-v1.md` for why each component was chosen; the code
and the tests are authoritative for what it does. `BENCHMARK.md` is the log of
the run that built it and is not maintained afterwards.

## Commands

```sh
bb test
bb golden
bb golden:accept       # only after reading the diff
./scripts/launcher.sh
./green build
./green create --dry-run
./green health         # read-only assertions against the live cluster
```

Never run a real `create`/`delete` without explicit authorization. Never edit or
read `.colors/`, and never read `.envrc.private`. Real deletion requires
`COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one run; never edit the
committed flag.

## Architecture

```text
create  start ─ infrastructure ─┬─ dns ──┐
                                └─ base ─┴─ cluster ─ backup ─ health
delete  start ─ load-infrastructure ─ cleanup ─ dns ─ infrastructure
health  start ─ load-infrastructure ─ health
```

`dns` and `base` fork and join at `cluster`. Stage names are remote-state keys
(`<profile>/mysql-ha-infrastructure.tfstate`) and must not move.

The package depends only on Green. Its own multi-node DigitalOcean template is
preferable to coupling to ONCE's single-server one, the way `k8s` decided.

Four things are load-bearing and easy to break:

1. **Bootstrapping is guarded.** `cluster.yml` bootstraps only after *every*
   member has reported it can see no ONLINE member anywhere. A member that
   bootstraps beside a live group forms a second group of one and the two
   diverge silently. Do not relax that condition to "this member sees no
   group".
2. **The reserved IP carries no `droplet_id` in OpenTofu.** Assignment belongs
   to the primary, not to desired state. Adding `droplet_id` to the resource
   makes every `create` after a failover move the endpoint back.
3. **`RESET MASTER` in `cluster.yml` is guarded by data, not by a marker
   file.** It runs only for a member whose `gtid_executed` does not contain
   `<group>:1`. Weakening that guard destroys GTID history on a live member.
4. **`group_replication_start_on_boot`** is `OFF` in `z-colors-ha.cnf` and `ON`
   in `zz-colors-ha-boot.cnf`, which deliberately notifies no handler.

## Safety

Credentials are `COLORS_PAR_*` only and never render: the three files on a
member that hold one (`/etc/mysql-ha/secrets.env`, `rclone.conf`,
`binlog-client.cnf`) are built by Ansible from `lookup('env', ...)` under
`no_log`. `COLORS_PAR_PROFILE` is refused.

The design needs exactly two database credentials —
`COLORS_PAR_MYSQL_ADMIN_PASSWORD` and `COLORS_PAR_MYSQL_REPLICATION_PASSWORD`.
Local agents authenticate as `root@localhost` over the unix socket with
`auth_socket`, so the admin password is never written to a member. Do not add
a third credential; solve it another way or report it.

Public ingress is SSH from `digitalocean-ssh-sources` and the MySQL port from
`digitalocean-client-sources`. The group port (33061) is VPC-only in both the
firewall and `group_replication_ip_allowlist`.

## Git

Work on the current branch. The launcher pin is managed only by `bb pin` after a
clean pushed commit; never invent or hand-edit `mysql-ha-sha`. Do not commit or
push unless explicitly asked.
