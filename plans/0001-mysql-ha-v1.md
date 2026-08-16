# 0001 — mysql-ha v1

A green-only Package Skill that provisions a MySQL failover cluster on
DigitalOcean with daily snapshots to Cloudflare R2, point-in-time recovery, and
a scheduled verified restore. The first and only consumer is
`../mysql-ha-digitalocean`.

The node budget is three droplets. A quorum store may be colocated on them; a
fourth tier of machines is not authorised. Everything below follows from that.

## 1. Replication topology — MySQL Group Replication, single-primary

Considered:

| Option | Why not |
|---|---|
| Asynchronous replication + Orchestrator | Orchestrator wants its own backend database and, for HA, its own Raft group of three. Colocating it on the data nodes means a failure domain shared with what it is supposed to arbitrate, and its backend would itself need replicating. Two consensus systems for one cluster. |
| Semi-synchronous replication + a hand-rolled promoter | The promoter *is* the hard part, and writing one is how split brain gets invented. There is no quorum without a third participant, and the third participant is the thing we are not allowed to add. |
| Galera / Percona XtraDB Cluster | Fits the budget (certification-based, built-in quorum) and is a genuine contender. Rejected because it is not MySQL: it forbids non-InnoDB tables, changes the semantics of `SELECT ... FOR UPDATE` across nodes, and requires an entirely separate binary. The brief asks for a MySQL failover cluster; using upstream MySQL keeps the restore path (`mysqldump`, `mysqlbinlog`) exactly the one MySQL documents. |
| **MySQL Group Replication, single-primary** | **Chosen.** |

Group Replication is a Paxos group (MySQL's XCom) formed by the mysqld
processes themselves. Three members give a majority of two, so the group
tolerates losing one member and elects a new primary automatically. The quorum
store is therefore colocated by construction — there is nothing extra to
install and no fourth tier.

Single-primary mode, not multi-primary: multi-primary needs
`group_replication_enforce_update_everywhere_checks` and turns every write
conflict into a rollback the application must handle. The brief asks for
failover, not for multi-writer.

Configuration that matters:

- `gtid_mode=ON`, `enforce_gtid_consistency=ON` — required, and also what makes
  the PITR design below work.
- `log_replica_updates=ON` — required by Group Replication, and the reason every
  member's binary log contains the whole transaction history.
- `group_replication_ip_allowlist` is the VPC CIDR, discovered at run time. The
  group port (33061) is never reachable from outside the VPC.
- `group_replication_exit_state_action=OFFLINE_MODE` — a member that loses the
  group stops serving rather than silently serving stale data.
- `group_replication_start_on_boot` is `OFF` while the group is being
  bootstrapped and `ON` afterwards, written as a second drop-in file so turning
  it on never triggers a restart handler.

## 2. Failover orchestrator — none, deliberately

The orchestrator is Group Replication's own membership service. There is no
Orchestrator, no Patroni, no keepalived, no etcd. Failure detection, quorum and
primary election are one mechanism instead of three that have to agree.

What the package adds is *endpoint* orchestration, which Group Replication does
not do.

## 3. Client endpoint — a Reserved IP claimed by the primary

`my-ha.bigconfig.space` is a Cloudflare A record whose content is a
DigitalOcean Reserved IP. The record never changes.

`mysql-ha-endpoint.timer` fires every 10 seconds on all three nodes. Each run
asks the local mysqld whether *this* member is `ONLINE` and `PRIMARY` and not
`super_read_only`; if it is not, the run exits. If it is, it asks the
DigitalOcean API which droplet currently holds the reserved IP, and if that is
not this droplet it unassigns and reassigns.

Considered instead:

- **MySQL Router.** Needs somewhere to run. On the data nodes it is one more
  hop that fails with the node; a fourth droplet is not authorised.
- **DigitalOcean Load Balancer.** Health-checking a MySQL TCP port cannot
  distinguish primary from secondary — every member accepts connections; only
  one accepts writes. A TCP load balancer would happily send writes to a
  read-only secondary.
- **Rewriting the Cloudflare A record.** Works, but makes the record's content
  mutable outside OpenTofu, so `./green create` would revert the failover and
  desired state would be permanently in drift. It also inherits DNS caching:
  MySQL client libraries resolve once per connection pool.

The reserved IP is created with no `droplet_id`, so assignment is explicitly
*not* desired state and OpenTofu never plans a change against the agent.

The DigitalOcean token the agent needs is `COLORS_PAR_DO_TOKEN`, which the
deployment already requires for compute. No new credential.

## 4. Backup tool — `mysqldump`, GTID-stamped, zstd, to R2

Considered:

| Option | Why not |
|---|---|
| Percona XtraBackup | Physical, fast, supports incrementals. Rejected on version coupling: XtraBackup's supported-server matrix is pinned tightly to MySQL point releases, and the server here is whatever `mysql-server-8.0` resolves to on Ubuntu 24.04 today. A backup tool that silently stops supporting the server after an unattended `apt upgrade` is a worse failure than a slower dump. |
| `mydumper`/`myloader` | Parallel logical dump, records GTID. A real improvement on `mysqldump` for large datasets and a reasonable future change. Not in Ubuntu 24.04's main archive, so it would add a third-party repository for a benefit this cluster's data volume does not need yet. |
| **`mysqldump --single-transaction --set-gtid-purged=ON`** | **Chosen.** In the archive, matched to the server by construction, and its output carries `SET @@GLOBAL.GTID_PURGED`, which is exactly the anchor the PITR replay needs. |

The snapshot runs on an ONLINE **secondary** so the primary is never the one
holding the consistent-read snapshot open. Only user schemas are dumped;
`mysql`, `sys`, `performance_schema` and `information_schema` are excluded so a
restore cannot overwrite the accounts of the server it is restored into.

Layout in `s3://mysql-ha-backup/<prefix>/`:

```
snapshot/<UTC ts>/dump.sql.zst
snapshot/<UTC ts>/meta.json      gtid_executed, binlog coordinates, node, sha256
snapshot/latest.json             a pointer to the newest complete snapshot
binlog/<node>/binlog.NNNNNN
restore-check/<UTC ts>.json
restore-check/latest.json
```

`latest.json` is written **after** the dump, so a partial upload is never
pointed at.

## 5. PITR — continuous raw binlog streaming from every member

`mysqlbinlog --read-from-remote-server --stop-never --raw` is MySQL's own
documented binary-log backup method. It holds an open replication connection to
the server and writes each event to a local file named exactly as the source
binlog, following rotations. A systemd service with `Restart=always` keeps the
stream up; a one-minute timer `rclone copy`s the spool to R2, re-uploading the
open file each minute so the recovery window is bounded by the timer, not by
binlog rotation.

Every member runs its own archiver into its own R2 prefix. In Group Replication
every ONLINE member applies and logs every transaction under the same GTID, so
any single prefix is a complete PITR source; three of them mean losing a node
does not lose the archive, and the archiver needs no leader election.

Recovery is therefore: restore the snapshot (which sets `GTID_PURGED`), then
pipe the archived binlogs through `mysql`. GTIDs already present are skipped
automatically, so replay is idempotent and needs no position arithmetic.

## 6. Verified restore — a scratch `mysqld`, daily

`mysql-ha-restore-check.timer` runs on the same self-elected node, offset after
the snapshot. It:

1. reads `snapshot/latest.json`, downloads the dump and verifies its sha256;
2. `mysqld --initialize-insecure` into `/var/lib/mysql-ha/verify/data`;
3. starts that instance on its own socket with `skip-networking`, a 128 MB
   buffer pool and its own binary log;
4. loads the dump, which sets `GTID_PURGED` to the snapshot's GTID set;
5. replays every archived binlog for this node through it;
6. asserts that `mysql_ha.heartbeat` in the restored copy is no older than
   `backup-restore-max-lag-seconds`, that `mysql_ha.beat_log` gained rows
   *after* the snapshot's timestamp (which is what proves the binlog replay did
   something), and that the restored `gtid_executed` is a superset of the
   snapshot's;
7. shuts the instance down, removes the datadir, and publishes the verdict to
   `restore-check/latest.json`.

Step 6 is why the cluster keeps a heartbeat at all: it is the only assertion
that distinguishes "the dump restored" from "the dump restored *and* the
point-in-time material on top of it was real".

Ubuntu confines `mysqld` with AppArmor to `/var/lib/mysql`, so the package adds
`/etc/apparmor.d/local/usr.sbin.mysqld` rather than disabling the profile.

## 7. Stage layout

```
start ─ infrastructure ─┬─ dns ──┐
                        └─ base ─┴─ cluster ─ backup ─ health
```

`dns` and `base` are genuinely independent — one talks to Cloudflare, the other
installs packages — so they fork and join at `cluster`, which needs both (the
group needs the servers up; nothing needs DNS, but joining there keeps the DNS
failure visible before any data-plane work starts).

Delete reverses it and reads node addresses out of remote state first, the way
`k8s/` does, because teardown cannot re-derive them:

```
start ─ load-infrastructure ─ cleanup ─ dns ─ infrastructure
```

`health` is a fourth verb: `start ─ load-infrastructure ─ health`. It is a
read-only assertion pass over the live cluster and needs no MySQL credential
locally — every query runs on the nodes over SSH.

One OpenTofu stage owns all three droplets via `count`, plus the reserved IP and
both firewalls; `k8s/` sets that precedent and it keeps the state addresses
stable. The VPC is a `data` source (`digitalocean_vpc` filtered by region
returns that region's default VPC), never a resource.

## 8. What the package refuses to do

- It needs exactly two database credentials, `COLORS_PAR_MYSQL_ADMIN_PASSWORD`
  and `COLORS_PAR_MYSQL_REPLICATION_PASSWORD`, and invents no third. The local
  agents authenticate to their own mysqld as `root@localhost` over the unix
  socket with `auth_socket`, which is how Ubuntu's package ships it — so the
  admin password is never written to any node.

## 9. The 32-character replication-channel limit

MySQL refuses a replication-channel password longer than 32 characters —
`ERROR 3056` from `CHANGE REPLICATION SOURCE TO`, `ERROR 3972` from
`START GROUP_REPLICATION ... PASSWORD=`. Both were probed on a live server;
nothing avoids it, and distributed recovery *is* a replication channel.

The `admin` account is unaffected: a normal MySQL account has no such limit and
carries `COLORS_PAR_MYSQL_ADMIN_PASSWORD` verbatim.

The `repl` account cannot. Rather than ask for a third credential, or truncate
the operator's secret — which would put a prefix of it into `mysql.user` and
into an option file on every member — the account's password is the first 128
bits of `SHA-256(COLORS_PAR_MYSQL_REPLICATION_PASSWORD)`, rendered as 32 hex
characters.

The operator still supplies exactly one replication secret. The package adapts
it to a protocol field whose width it does not control, in a way that reveals
nothing about the input, keeps 128 bits of entropy on an account that is only
reachable inside the VPC, and — being hex — cannot be misread as syntax by any
of the SQL statements or option files it passes through.

The derivation appears once, as an Ansible expression, and both consumers (the
`CREATE`/`ALTER USER` statements and the archiver's `binlog-client.cnf`) read
that one expression, so they cannot drift apart.
- `compute-prevent-destroy` renders into every destroyable resource.
- Nothing secret is ever rendered. Ansible resolves `COLORS_PAR_*` at play time
  with `lookup('env', ...)` under `no_log`.
