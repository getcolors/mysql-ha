// Launcher contract, node topology, and the small derivations several
// modules share — the port of io.github.getcolors.mysql-ha.utils.
//
// The topology is a pure function of desired state: three homogeneous members
// numbered from one. Nothing here reaches a network, so tests can assert the
// whole shape of the cluster without provisioning anything.

import { stageDir } from "red/cli";
import type { Opts } from "red/workflow";

// Minimum mysql-ha contract a standalone launcher must find. Bump on any
// change a launcher pinned to an older commit could not survive.
export const contract = 1;

export function nodeCount(opts: Opts): number {
  const n = opts["cluster-nodes"];
  return typeof n === "number" && Number.isInteger(n) ? n : 3;
}

export function ordinals(opts: Opts): number[] {
  return Array.from({ length: nodeCount(opts) }, (_, i) => i + 1);
}

// The DigitalOcean droplet name for member `ordinal`, and the Ansible
// inventory host alias. One name, so a droplet in the console and a host in a
// play recap are obviously the same thing.
export function nodeName(opts: Opts, ordinal: number): string {
  return `${opts["digitalocean-name"]}-node-${ordinal}`;
}

export function nodeNames(opts: Opts): string[] {
  return ordinals(opts).map((ordinal) => nodeName(opts, ordinal));
}

// MySQL `server_id`. Distinct per member and stable across rebuilds, because
// it is derived from the ordinal rather than from an address.
export function serverId(ordinal: number): number {
  return 100 + ordinal;
}

// The pseudo-replica id `mysqlbinlog --read-from-remote-server` registers
// with. It must not collide with any real member's `server_id`.
export function connectionServerId(ordinal: number): number {
  return 200 + ordinal;
}

// `node-2.my-ha.bigconfig.space` — the per-member administrative name. The
// cluster host itself always points at the reserved IP, never at a member.
export function nodeHost(opts: Opts, ordinal: number): string {
  return `node-${ordinal}.${opts["cluster-host"]}`;
}

// The Cloudflare record name relative to nothing — Cloudflare 5.x takes the
// fully qualified name, so this is the FQDN with the trailing dot removed.
export function recordName(host: unknown): string {
  return String(host ?? "").replace(/\.$/, "");
}

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "mysql-ha" });
}

// Object-key prefix inside the backup bucket, without a trailing slash.
export function backupPrefix(opts: Opts): string {
  return String(opts["backup-r2-prefix"] ?? "").replace(/\/+$/, "");
}

const durationRe = /^[0-9]+(?:ms|s|m|h|min|d)$/;

export function duration(x: unknown): boolean {
  return typeof x === "string" && durationRe.test(x);
}
