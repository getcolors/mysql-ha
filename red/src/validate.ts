// The provider registry and the desired-state rules it drives — the port of
// io.github.getcolors.mysql-ha.validate.
//
// The registry is package-owned rather than inherited from ONCE: this package
// ships its own multi-node DigitalOcean template, so coupling its validation to
// ONCE's single-server key set would check for keys no stage here uses and miss
// the ones it does. `k8s` made the same call for the same reason.
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
import * as utils from "./utils.ts";

// Provider slot -> provider name -> what that choice implies.
//
// `required` are non-secret keys a template interpolates. `secrets` arrive
// only through `COLORS_PAR_*`. `tofuEnv` is the subset OpenTofu reads
// natively from the process environment, so a credential never has to be
// rendered into a .tf file sitting in the work directory in plaintext.
export const providers: providerOps.Registry = {
  "provider-compute": {
    digitalocean: {
      required: ["digitalocean-name", "digitalocean-region",
                 "digitalocean-size", "digitalocean-image",
                 "digitalocean-ssh-keys", "digitalocean-vpc-mode"],
      secrets: ["do-token"],
      tofuEnv: { "do-token": "DIGITALOCEAN_TOKEN" },
    },
  },

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

function slotKeys(opts: Opts, field: "required" | "secrets"): string[] {
  return providerOps.slotKeys(providers, opts, slots, field);
}

function missing(opts: Opts, keys: string[]): string[] {
  return providerOps.missingKeys(opts, keys);
}

export const hostRe =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const uuidRe =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const cidrRe = /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}\/[0-9]{1,2}$/;
export const bufferPoolRe = /^[0-9]+[KMG]$/;
export const oncalendarRe = /^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$/;

const positiveInt = (x: unknown) =>
  typeof x === "number" && Number.isInteger(x) && x > 0;

// The way Clojure's pr-str prints the value inside green's messages: strings
// quoted, nil spelled out.
function prStr(x: unknown): string {
  return x === undefined || x === null ? "nil" : JSON.stringify(x);
}

function cidrListErrors(opts: Opts, k: string): string[] {
  const v = opts[k];
  if (placeholder(v)) return [];
  if (!Array.isArray(v)) return [`:${k} must be a list of CIDRs`];
  if (v.length === 0) return [`:${k} must list at least one CIDR`];
  return v.flatMap((c) =>
    cidrRe.test(String(c)) ? [] : [`:${k} entry ${prStr(c)} is not a CIDR`]);
}

// Everything wrong with `opts` that does not depend on a credential. Empty
// means the desired state renders.
export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of missing(opts, [...ownRequired, ...slotKeys(opts, "required")])) {
    errors.push(`:${key} is required`);
  }
  for (const slot of slots) {
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
  errors.push(...cidrListErrors(opts, "digitalocean-ssh-sources"));
  errors.push(...cidrListErrors(opts, "digitalocean-client-sources"));
  return errors;
}

// Credentials a real run needs that no `COLORS_PAR_*` variable supplied.
//
// `health` reads remote state and talks to the nodes over SSH; every MySQL
// query it makes runs on the node against its local socket, so it needs the
// provider credentials and none of the database ones.
export function secretErrors(opts: Opts): string[] {
  const keys = opts["red/event"] === "health"
    ? slotKeys(opts, "secrets")
    : [...slotKeys(opts, "secrets"), ...ownSecrets];
  return [...new Set(missing(opts, keys))]
    .map((key) => `required credential is not set: ${parName(key)}`);
}
