# BENCHMARK.md

Running log for the `mysql-ha` benchmark run. Written as the work happened, not
retrospectively. Timestamps are ISO-8601 local (Europe/Rome, UTC+02:00).

## Phase log

### 2026-08-16T09:30:04+02:00 — design

Read `~/code/getcolors/CLAUDE.md`, then `clickhouse/` (the only multi-node
package), `k8s/` (the only multi-node **DigitalOcean** package),
`vaultwarden/` (backup-to-R2 with Litestream), `once/green` (the provider
registry and the DigitalOcean droplet template) and the `green` SDK itself
(`workflow`, `tofu`, `ansible`, `scaffold`, `lifecycle`, `providers`, `cli`).

`postgres-ha/` and `postgres-ha-digitalocean/` were not read, referenced, or
touched at any point in this run.

### 2026-08-16T09:36:26+02:00 — package scaffold

Repository skeleton, `deps.edn` (Green only, pinned at the SHA every other
package in the workspace currently pins), `bb.edn`, `.gitignore`, and
`plans/0001-mysql-ha-v1.md`.

### 2026-08-16T09:40:00+02:00 — compute stage

`src/clj/.../{utils,validate,tools,workflow}.clj`, the DigitalOcean
infrastructure template and the Cloudflare DNS template. First `./green build`
of the fixture succeeded on the first attempt.

### 2026-08-16T09:44:00+02:00 — replication

`files/mysqld.cnf` (the Group Replication configuration) and `cluster.yml` (the
guarded bootstrap, the two accounts, the recovery channel, the join, the
schema, and the start-on-boot drop-in).

### 2026-08-16T09:47:00+02:00 — failover

`files/mysql-ha-endpoint` and its 10-second timer: the reserved-IP claim.

### 2026-08-16T09:48:00+02:00 — backup

`files/mysql-ha-snapshot` and the R2 layout.

### 2026-08-16T09:49:00+02:00 — PITR

`files/mysql-ha-binlog-archive` and `files/mysql-ha-binlog-upload`.

### 2026-08-16T09:50:00+02:00 — restore verification

`files/mysql-ha-restore-check`, `files/verify.cnf`, and the AppArmor override.

### 2026-08-16T09:55:37+02:00 — package checks green

`bb test` (38 tests, 139 assertions), `./scripts/golden.sh`, and
`./scripts/launcher.sh` (9 checks) all pass. The goldens were recorded for the
first time in this run — there was nothing to diff against, and the recorded
tree was read before being committed.

No failures in any of the three. That is the whole first-attempt record for the
offline half of the work.

## Design decisions

Each of these had to be made for this package. Where the workspace already had
a precedent it is named; where it did not, that is called out. The full
argument is in `plans/0001-mysql-ha-v1.md`.

| Decision | Choice | Precedent in workspace |
|---|---|---|
| Replication topology | MySQL Group Replication, single-primary | **none** |
| Failover orchestrator | Group Replication's own Paxos group — no external orchestrator, no fourth tier | **none** |
| Quorum store | The group itself (colocated, 3 members) | **none** |
| Client endpoint | DigitalOcean Reserved IP claimed by whichever member is PRIMARY; DNS is a static A record to it | **none** |
| Backup tool | `mysqldump` logical snapshot, zstd-compressed, GTID-stamped | vaultwarden streams SQLite with Litestream — not transferable |
| PITR mechanism | `mysqlbinlog --read-from-remote-server --stop-never --raw` on every member, uploaded to R2 each minute | **none** |
| Verified restore | Second `mysqld` on the elected member, restored from snapshot + binlog replay, asserted against the heartbeat table | vaultwarden has a weekly `restore-check`; the mechanism is entirely different |
| Package dependencies | Green only, own DigitalOcean template | `k8s/` |
| Stage layout | one `*-infrastructure` tofu stage with `count`, one `*-dns` stage, one Ansible directory with several playbooks | `k8s/` + `clickhouse/` |

## Decisions with no precedent in this workspace

1. **Group Replication rather than async replication plus an external
   orchestrator.** The node budget is three droplets and a quorum store may
   only be colocated. Orchestrator/Patroni-style designs want an odd-sized
   consensus store that is not the database; Group Replication *is* a Paxos
   group, so the quorum store is the three mysqld processes themselves. This is
   the only topology that fits the budget without colocating a second consensus
   system.
2. **A DigitalOcean Reserved IP as the client endpoint, not a DNS swing.** The
   workspace has no floating-IP precedent — every existing package points DNS
   straight at a droplet. A DNS swing would need the Cloudflare record's content
   to be mutable outside OpenTofu, which puts desired state permanently in
   drift. A Reserved IP keeps the A record constant (it is the reserved
   address, forever) and moves the L3 endpoint instead. `digitalocean_reserved_ip`
   is therefore created **without** `droplet_id`, so the assignment is not
   desired state and the agent and OpenTofu never fight.
3. **Archiving binlogs from every member rather than from the primary.** In
   Group Replication every ONLINE member writes every transaction to its own
   binary log under the same GTID. Archiving all three to separate R2 prefixes
   means PITR material survives the loss of any node and needs no leader
   election in the archiver at all.
4. **A self-electing backup role with no external state.** The snapshot and the
   restore check run on the ONLINE SECONDARY with the lowest `MEMBER_ID`,
   falling back to the PRIMARY when the group has no secondary. Every node runs
   the same timer and all but one exit immediately. No lease, no lock, no
   fourth machine.
5. **An AppArmor local override for the verification instance.** Ubuntu confines
   `mysqld` to `/var/lib/mysql`. The verified restore starts a second `mysqld` on
   a scratch datadir, which the shipped profile denies. `/etc/apparmor.d/local/usr.sbin.mysqld`
   is extended rather than the profile being disabled.

## External components provisioned or installed

Recorded with the versions actually observed on the live cluster; see the
"real deploy" phase entries below.

## Failed checks

Every failing command, its error, and what it took to fix, in the order they
happened.
