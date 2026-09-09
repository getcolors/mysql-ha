import { parName } from "red/cli";
import * as providerOps from "red/providers";
import type { Opts } from "red/workflow";
import {registry,validate as computeValidate,plan_deployment,keyMode} from "colors-compute-red";
import * as compute from "./compute.ts";

import * as utils from "./utils.ts";

export const computeProviders=registry.compute;
export const defaultComputeProvider='digitalocean';
export const providers: providerOps.Registry = {

  "provider-dns": {
    cloudflare: {
      required: ["cloudflare-zone"],
      secrets: ["cloudflare-api-token"],
      tofuEnv: { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" },
    },
  },

  "provider-backend": Object.fromEntries(Object.entries(registry.backend).map(([k,v])=>[k,{required:v.required,secrets:v.secrets,tofuEnv:{}}])),
};

export const slots = ["provider-compute", "provider-dns", "provider-backend"];

export const ownSlots = ["provider-dns", "provider-backend"];

export const ownRequired = [
  "profile", "workdir",
  "cluster-host", "cluster-nodes",
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

export function keygen(opts: Opts): boolean {
  try{return keyMode(opts).mode==='managed';}catch{return true;}
}

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

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of missing(opts, [...ownRequired,
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
  // Opt-out mode reaches the members with the operator's own key, so the path
  // to it is desired state there; keygen mode names the generated key itself
  // and must not be asked for one.
  if (!keygen(opts) && placeholder(keyMode(opts).private_key_path)) {
    errors.push(":ssh-private-key-path is required for external SSH access");
  }
  if (opts["cluster-nodes"] !== 3) {
    errors.push(":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets");
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
  errors.push(...computeValidate(opts));
  if(!errors.length)try{plan_deployment(opts,compute.topology(opts),compute.requirements(opts));}catch(error){errors.push((error as Error).message);}
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
