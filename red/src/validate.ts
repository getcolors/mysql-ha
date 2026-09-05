// The provider registry and the desired-state rules it drives — the port of
// io.github.getcolors.mysql-ha.validate.
//
// The compute registry is package-owned — this package ships its own
// multi-node DigitalOcean template — and the operations over it are ONCE's
// `computeCluster` module, the one implementation of the Compute Cluster
// Standard: selection, the required keys, the source lists, the provider
// rules, the network mode and the topology are checked there over `spec`,
// never copied here. What stays here is what only this package knows: the
// fixed member count, the discovered VPC, and every MySQL rule.
//
// Two credentials reach MySQL — the admin password and the replication
// password — and the design is built to need no third. Nothing in here invents
// one.
//
// Green renders its keys as Clojure keywords, so every message here carries the
// same leading colon — the three colours must report identical errors for one
// colors.yml.

import { parName } from "red/cli";
import * as providerOps from "red/providers";
import type { Opts } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as utils from "./utils.ts";

// provider-compute -> what that choice implies.
//
// `required` are non-secret keys the template interpolates. `secrets` arrive
// only through `COLORS_PAR_*`. `tofuEnv` is the subset OpenTofu reads
// natively from the process environment, so a credential never has to be
// rendered into a .tf file sitting in the work directory in plaintext.
// `network` is discovered: the region's default VPC, never one this package
// owns. `digitalocean-ssh-keys` stays a required literal key; the SSH Keypair
// Standard is a separate adoption.
export const computeProviders: computeCluster.ClusterRegistry = {
  digitalocean: {
    required: ["digitalocean-name", "digitalocean-region",
               "digitalocean-size", "digitalocean-image",
               "digitalocean-ssh-keys", "digitalocean-vpc-mode"],
    secrets: ["do-token"],
    tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    network: { mode: "discovered" },
  },
};

// The provider a deployment created before this package recorded one in its
// compute output must be running: the only one it ever offered.
export const defaultComputeProvider = "digitalocean";

// How this package describes itself to ONCE's `computeCluster`. One
// homogeneous role of `cluster-nodes` members, whose fallback addresses start
// at offset 11 so that `build` renders the same 192.0.2.11-13 and
// 10.110.0.11-13 it always did, with 192.0.2.10 left to the reserved IP. The
// fallback subnet stands in for the discovered VPC's range on a build; on a
// real run the range is the compute state's `vpc_ip_range`.
export const spec: computeCluster.ClusterSpec = {
  registry: computeProviders,
  default: defaultComputeProvider,
  sources: { nonEmpty: ["ssh-sources", "client-sources"], mayBeEmpty: [] },
  roles: [{ role: null, countKey: "cluster-nodes", count: 3, fallbackOffset: 11 }],
  fallbackSubnet: "10.110.0.0/20",
};

// Provider slot -> provider name -> what that choice implies. The compute slot
// is the registry above, so the OpenTofu environment and the secrets are read
// from one place whichever slot a stage asks for.
export const providers: providerOps.Registry = {
  "provider-compute": computeProviders,

  "provider-dns": {
    cloudflare: {
      required: ["cloudflare-zone"],
      secrets: ["cloudflare-api-token"],
      tofuEnv: { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" },
    },
  },

  "provider-backend": {
    local: { required: [], secrets: [], tofuEnv: {} },
    s3: { required: ["s3-bucket", "s3-region"], secrets: [], tofuEnv: {} },
    // R2 is S3-compatible, so it authenticates through the AWS chain. Naming
    // the keys in backend.tf.json would also copy them into .terraform/.
    r2: {
      required: ["r2-bucket", "r2-endpoint"],
      secrets: ["r2-access-key-id", "r2-secret-access-key"],
      tofuEnv: { "r2-access-key-id": "AWS_ACCESS_KEY_ID",
                 "r2-secret-access-key": "AWS_SECRET_ACCESS_KEY" },
    },
  },
};

export const slots = ["provider-compute", "provider-dns", "provider-backend"];

// The slots this package selects and checks itself; the compute slot is ONCE's.
export const ownSlots = ["provider-dns", "provider-backend"];

export const ownRequired = [
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
];

// The two database credentials the brief allows, plus the separate R2 key pair
// the nodes use for the backup bucket. The backup key pair is deliberately not
// the state-backend key pair: the state bucket and the backup bucket are
// different blast radii.
export const ownSecrets = [
  "mysql-admin-password", "mysql-replication-password",
  "backup-r2-access-key-id", "backup-r2-secret-access-key",
];

export const placeholder = (x: unknown) => providerOps.placeholder(x);

export const profilePar = parName("profile");

// `COLORS_PAR_PROFILE` keys this deployment's remote state. Overlaying it can
// only point one deployment at another's, so it is refused rather than honoured.
export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "") !== ""
    ? [`${profilePar} is set. mysql-ha takes profile from colors.yml only.`]
    : [];
}

function slotKeys(opts: Opts, slotNames: string[], field: "required" | "secrets"): string[] {
  return providerOps.slotKeys(providers, opts, slotNames, field);
}

function missing(opts: Opts, keys: string[]): string[] {
  return providerOps.missingKeys(opts, keys);
}

export const hostRe =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const uuidRe =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const bufferPoolRe = /^[0-9]+[KMG]$/;
export const oncalendarRe = /^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$/;

const positiveInt = (x: unknown) =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

// The way Clojure's pr-str prints the value inside green's messages: strings
// quoted, nil spelled out.
function prStr(x: unknown): string {
  return x === undefined || x === null ? "nil" : JSON.stringify(x);
}

// Everything wrong with `opts` that does not depend on a credential. Empty
// means the desired state renders. The missing keys are this package's, the
// selected compute provider's (ONCE's `requiredKeys`) and the other slots';
// the package's own rules follow; the Compute Cluster Standard's — selection,
// the source lists, the provider and network rules, the topology — are ONCE's
// over `spec` and come last.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of missing(opts, [...ownRequired,
                                   ...compute.requiredKeys(spec, opts),
                                   ...slotKeys(opts, ownSlots, "required")])) {
    errors.push(`:${key} is required`);
  }
  for (const slot of ownSlots) {
    const p = opts[slot];
    if (!(typeof p === "string" && p in (providers[slot] ?? {}))) {
      errors.push(`unsupported :${slot} ${prStr(p)}`);
    }
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  if (typeof opts["cloudflare-proxied"] !== "boolean") {
    errors.push(":cloudflare-proxied must be true or false");
  }
  if (opts["cloudflare-proxied"] === true) {
    errors.push(":cloudflare-proxied must be false; Cloudflare's proxy does not carry the MySQL protocol");
  }
  if (!(placeholder(opts["cluster-host"]) || hostRe.test(String(opts["cluster-host"])))) {
    errors.push(":cluster-host must be a fully qualified hostname");
  }
  if (!(placeholder(opts["cluster-host"]) || placeholder(opts["cloudflare-zone"])
        || String(opts["cluster-host"]).endsWith(`.${opts["cloudflare-zone"]}`))) {
    errors.push(":cluster-host must sit inside :cloudflare-zone");
  }
  if (opts["cluster-nodes"] !== 3) {
    errors.push(":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets");
  }
  if (opts["digitalocean-vpc-mode"] !== "default") {
    errors.push(":digitalocean-vpc-mode must be default; the VPC is discovered at run time and is never desired state");
  }
  if (!(placeholder(opts["mysql-group-name"]) || uuidRe.test(String(opts["mysql-group-name"])))) {
    errors.push(":mysql-group-name must be a UUID; MySQL rejects anything else as a group name");
  }
  for (const k of ["mysql-port", "mysql-group-port", "backup-retention-days",
                   "backup-restore-max-lag-seconds"]) {
    if (!positiveInt(opts[k])) errors.push(`:${k} must be a positive integer`);
  }
  if (opts["mysql-port"] === opts["mysql-group-port"]) {
    errors.push(":mysql-group-port must differ from :mysql-port");
  }
  if (!(placeholder(opts["mysql-innodb-buffer-pool-size"])
        || bufferPoolRe.test(String(opts["mysql-innodb-buffer-pool-size"])))) {
    errors.push(":mysql-innodb-buffer-pool-size must be a size such as 1G");
  }
  for (const k of ["heartbeat-interval", "endpoint-poll-interval",
                   "backup-binlog-upload-interval"]) {
    if (!placeholder(opts[k]) && !utils.duration(opts[k])) {
      errors.push(`:${k} must be a systemd duration such as 10s or 1min`);
    }
  }
  for (const k of ["backup-snapshot-oncalendar", "backup-restore-check-oncalendar"]) {
    if (!placeholder(opts[k]) && !oncalendarRe.test(String(opts[k]))) {
      errors.push(`:${k} must be a systemd OnCalendar expression such as *-*-* 01:00:00`);
    }
  }
  if (!placeholder(opts["backup-r2-bucket"]) && !placeholder(opts["r2-bucket"])
      && String(opts["backup-r2-bucket"]) === String(opts["r2-bucket"])) {
    errors.push(":backup-r2-bucket must not be the state bucket");
  }
  errors.push(...computeCluster.stateErrors(spec, opts));
  return errors;
}

// Credentials a real run needs that no `COLORS_PAR_*` variable supplied.
//
// `health` reads remote state and talks to the nodes over SSH; every MySQL
// query it makes runs on the node against its local socket, so it needs the
// provider credentials and none of the database ones.
export function secretErrors(opts: Opts): string[] {
  const keys = opts["red/event"] === "health"
    ? slotKeys(opts, slots, "secrets")
    : [...slotKeys(opts, slots, "secrets"), ...ownSecrets];
  return [...new Set(missing(opts, keys))]
    .map((key) => `required credential is not set: ${parName(key)}`);
}
