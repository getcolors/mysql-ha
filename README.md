# mysql-ha

A [Colors](https://www.getcolors.ai) Package Skill that provisions and operates
a **three-member MySQL Group Replication cluster on DigitalOcean**, with daily
snapshots and continuously archived binary logs in Cloudflare R2, and a
scheduled restore that is actually performed and asserted rather than assumed.

One command creates it, one command checks it, and the failover needs no
command at all.

```sh
npx skills add getcolors/mysql-ha
cp .agents/skills/package-mysql-ha-green/green ./green
./green build              # render only — contacts nothing, needs no credential
./green create --dry-run   # walk the graph, touch nothing
./green create             # converge for real
./green health             # assert the live cluster
```

## What it builds

Three identical `s-2vcpu-4gb` droplets in one region, inside that region's
default VPC, running MySQL 8.0 in **single-primary Group Replication**.

| Concern | Mechanism |
|---|---|
| Replication | MySQL Group Replication, single-primary, GTID |
| Quorum | the group itself — three mysqld processes are the Paxos group |
| Failure detection and election | Group Replication's own membership service |
| Client endpoint | a DigitalOcean **reserved IP** claimed by whichever member is primary |
| DNS | one Cloudflare `A` record pointing at the reserved IP, which never changes |
| Snapshots | `mysqldump --single-transaction --set-gtid-purged=ON`, zstd, daily, to R2 |
| Point-in-time recovery | `mysqlbinlog --read-from-remote-server --stop-never --raw` on every member, uploaded each minute |
| Verified restore | a scratch `mysqld` rebuilt daily from snapshot + archive, then asserted |

The deployment owns its SSH keypair (the workspace SSH Keypair Standard,
keygen mode): with no `digitalocean-ssh-keys` in `colors.yml`, the first real
`create` generates `~/.ssh/<profile>` and `~/.ssh/<profile>.pub`, registers
the public key at DigitalOcean under the profile's name, and `delete` removes
the key last, after the droplets are gone. Supplying `digitalocean-ssh-keys`
(and then `digitalocean-ssh-private-key`, the path to its private half) opts
out: the package uses the listed key and touches no key material. Either way
`create` writes one managed block into `~/.ssh/config` with an alias per
member — `<profile>` for member one, `<profile>-0`, `<profile>-1`,
`<profile>-2` — and `delete` removes it before the destroy (the workspace SSH
Config Standard), so `ssh <profile>-1` reaches member two by name.

There is no orchestrator, no keepalived, no etcd, and no fourth machine.
Failure detection, quorum and election are one mechanism instead of three that
have to agree with each other.

## Failover

Group Replication elects a new primary as soon as the surviving majority agrees
the old one is gone — typically within about five seconds of the failure being
detected.

The client endpoint follows separately. `mysql-ha-endpoint.timer` fires every
ten seconds on all three members; each run asks the local server whether *this*
member is `ONLINE`, `PRIMARY` and not `super_read_only`, and all but one exit
immediately. The one that does not calls the DigitalOcean API and moves the
reserved IP to itself.

Nothing about DNS changes: `my-ha.example.com` is an `A` record whose content
is the reserved IP, forever. Clients keep resolving the same address; the
address starts arriving at a different droplet.

To exercise it deliberately — `kill`, not `stop`, so the member never gets to
leave the group politely:

```sh
ssh root@node-1.my-ha.example.com systemctl kill -s SIGKILL mysql.service
```

Measured on a three-member cluster in `ams3`, from the moment the primary's
mysqld was killed:

| | |
|---|---|
| new primary elected | ~23s |
| reserved IP reassigned | ~36s |
| `my-ha.example.com` serving the new primary, writable | ~43s |

The first number is Group Replication's own failure detection and election. The
rest is `endpoint-poll-interval` plus a DigitalOcean unassign/assign round trip,
so shortening the poll shortens the tail. The DNS record is not involved at any
point and never changes.

Bringing the old member back is one command and no coordination:

```sh
ssh root@node-1.my-ha.example.com systemctl start mysql
```

It rejoins by itself within seconds, as a secondary, because
`group_replication_start_on_boot` is on once the group exists.

Running `./green create` after a failover is safe and does **not** move the
endpoint back: the reserved IP's assignment is deliberately not desired state.

## Backups

Everything lands in one R2 bucket under one prefix:

```text
snapshot/<UTC ts>/dump.sql.zst    the daily logical snapshot
snapshot/<UTC ts>/meta.json       gtid_executed, sha256, size, schemas, node
snapshot/latest.json              written last, so it never points at a partial upload
binlog/<member>/binlog.NNNNNN     the point-in-time material, one prefix per member
restore-check/<UTC ts>.json       the verdict of each verified restore
restore-check/latest.json
```

The snapshot runs on an ONLINE **secondary** — chosen by the members themselves,
without a lease or a coordinator — so the primary never holds the
consistent-read snapshot open. Only user schemas are dumped: restoring `mysql`
would overwrite the accounts of whatever server it was restored into.

Binary logs are archived from **every** member. In Group Replication every
ONLINE member logs every transaction under the same GTID, so any one prefix is
a complete recovery source, and three of them mean losing a member does not
lose the archive.

## Recovery

### Point-in-time restore

The snapshot carries `SET @@GLOBAL.GTID_PURGED`, so the archived logs replay
idempotently on top of it — transactions the dump already contained are skipped
by GTID and there is no position arithmetic anywhere in the procedure.

On a member (or any host with the bucket credentials and a MySQL 8.0 client):

```sh
# 1. what is the newest published snapshot
rclone --config /etc/mysql-ha/rclone.conf cat r2:$BUCKET/$PREFIX/snapshot/latest.json
# -> {"snapshot":"20260816T010000Z","gtid_executed":"...","sha256":"..."}

# 2. fetch and check it
rclone ... copyto r2:$BUCKET/$PREFIX/snapshot/20260816T010000Z/dump.sql.zst ./dump.sql.zst
sha256sum ./dump.sql.zst        # must equal meta.json's sha256

# 3. fetch the point-in-time material from any member's prefix
rclone ... copy r2:$BUCKET/$PREFIX/binlog/<member>/ ./binlog/

# 4. load the snapshot into a fresh server
zstd -dc ./dump.sql.zst | mysql --socket=/path/to/target.sock

# 5. replay up to the moment you want.
#    Everything:
mysqlbinlog ./binlog/binlog.* | mysql --socket=/path/to/target.sock
#    Or up to a point in time:
mysqlbinlog --stop-datetime='2026-08-16 09:14:00' ./binlog/binlog.* \
  | mysql --socket=/path/to/target.sock
```

Timestamps are UTC: every member runs with `default_time_zone = '+00:00'`
precisely so that a `--stop-datetime` means the same thing everywhere.

`mysql_ha.beat_log` is a per-ten-second heartbeat with the writing member's
name, which is the easiest way to confirm you landed where you meant to:

```sql
SELECT ts, node FROM mysql_ha.beat_log ORDER BY ts DESC LIMIT 5;
```

### Rebuilding one member

Destroy nothing. Stop MySQL on the member, clear `/var/lib/mysql`, and run
`./green create` again: the member is treated as fresh, its binary log is
cleared, and it rejoins by distributed recovery from a donor.

### Rebuilding the whole cluster

If every member is down at once, `./green create` bootstraps from member one
again. Member one is then the source of truth, so if it was behind when the
cluster died, the difference is lost — recover it from the archive with the
point-in-time procedure above before letting the others rejoin.

## Health

`./green health` runs, on every member, a check of:

- three members ONLINE and exactly one primary;
- this member ONLINE, and its applier queue moving;
- the heartbeat no more than 60 seconds old *on this member*, which is what
  proves writes are actually replicating here rather than merely being accepted
  somewhere;
- `my-ha.example.com` resolving to the reserved IP, and the reserved IP held by
  the primary's droplet;
- a snapshot published in the last 26 hours, whose dump object exists;
- binary-log objects touched in the last 10 minutes;
- `restore-check/latest.json` reporting `ok` within the last 26 hours.

`create` finishes by running the same checks, and by actually taking a snapshot
and performing a verified restore before it returns — a backup chain that is
only tested once is a backup chain that is not tested.

## Configuration

`colors.yml` is the only file to edit, and it holds non-secret values only. See
[`skills/package-mysql-ha-green/references/configuration.md`](skills/package-mysql-ha-green/references/configuration.md)
for every key.

Credentials are `COLORS_PAR_*` environment variables, kept in a gitignored
`.envrc.private`:

| Variable | For |
|---|---|
| `COLORS_PAR_DO_TOKEN` | droplets, firewalls, and the reserved-IP claim |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | the DNS records |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | the OpenTofu state bucket |
| `COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID` / `..._SECRET_ACCESS_KEY` | the backup bucket |
| `COLORS_PAR_MYSQL_ADMIN_PASSWORD` | the `admin` account clients use |
| `COLORS_PAR_MYSQL_REPLICATION_PASSWORD` | distributed recovery and the binary-log archiver |

Never export `COLORS_PAR_PROFILE`: the profile names this deployment's state
keys, and overlaying it can only point one deployment at another's.

The two database passwords are the only ones the design needs. Agents on a
member authenticate to their own server as `root@localhost` over the unix
socket, the way Ubuntu ships it, so the admin password is never written to a
member at all.

One thing to know about the second one: MySQL refuses a replication-channel
password longer than 32 characters, and distributed recovery is a replication
channel. Rather than ask for a third credential or truncate yours, the `repl`
account carries the first 128 bits of your value's SHA-256, as hex. If you ever
connect as `repl` by hand, that is the string:

```sh
printf '%s' "$COLORS_PAR_MYSQL_REPLICATION_PASSWORD" | sha256sum | cut -c1-32
```

`admin` carries `COLORS_PAR_MYSQL_ADMIN_PASSWORD` exactly as you set it.

## Development

The package is tri-colour: the canonical Clojure implementation lives in
`green/`, with byte-identical TypeScript/Bun and Python/uv implementations in
`red/` and `blue/`.

```sh
cd green && bb test      # unit suite (canonical Clojure implementation)
cd green && bb golden    # render the fixture and diff it against the record
cd red && bun test && bun run typecheck   # TypeScript implementation
cd blue && uv run pytest                  # Python implementation
./scripts/parity.sh      # all three colours render byte-identical trees
./scripts/launcher.sh    # what the unit suite cannot reach: the copied payload
```

`GREEN_LIB_ROOT` and `MYSQL_HA_LIB_ROOT` point the launchers at working trees
instead of pins. A change spanning two repositories is two commits in two
repositories, upstream pushed first; `bb pin` (in `green/`) stamps all three
launchers only from a clean, pushed HEAD.

## License

MIT. See [LICENSE](LICENSE).
