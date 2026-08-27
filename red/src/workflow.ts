// The lifecycle graph, preflight, and the backend advice each OpenTofu stage
// runs behind — the port of io.github.getcolors.mysql-ha.workflow.
//
// Create forks after the infrastructure: Cloudflare and apt have nothing to say
// to each other, so `dns` and `base` run in parallel and join at `cluster`.
// Joining DNS there rather than leaving it dangling means a bad zone or a
// missing token surfaces before any data-plane work starts.
//
// Delete and health both begin by reading node addresses out of remote state,
// because neither can re-derive them.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, workflow, type Opts, type WireDecl } from "red/workflow";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": "digitalocean",
  "provider-dns": "cloudflare",
  "provider-backend": "local",
  workdir: ".colors",
};

// Events that reach a provider and therefore need credentials. `build` is
// deliberately absent: a fresh checkout with an empty environment must render.
export const credentialEvents = ["create", "delete", "health"];

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && credentialEvents.includes(String(event))
          ? validate.secretErrors(current)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "mysql-ha/start": [startStep, "mysql-ha/load-infrastructure"],
      "mysql-ha/load-infrastructure": [tools.loadInfrastructureStep, "mysql-ha/cleanup"],
      "mysql-ha/cleanup": [tools.cleanupStep, "mysql-ha/dns"],
      "mysql-ha/dns": [tools.dnsStep, "mysql-ha/infrastructure"],
      "mysql-ha/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  if (runOpts["red/event"] === "health") {
    const graph: Record<string, WireDecl> = {
      "mysql-ha/start": [startStep, "mysql-ha/load-infrastructure"],
      "mysql-ha/load-infrastructure": [tools.loadInfrastructureStep, "mysql-ha/health"],
      "mysql-ha/health": [tools.healthStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "mysql-ha/start": [startStep, "mysql-ha/infrastructure"],
    "mysql-ha/infrastructure": [tools.infrastructureStep, "mysql-ha/dns", "mysql-ha/base"],
    "mysql-ha/dns": [tools.dnsStep, "mysql-ha/cluster"],
    "mysql-ha/base": [tools.baseStep, "mysql-ha/cluster"],
    "mysql-ha/cluster": [tools.clusterStep, "mysql-ha/backup"],
    "mysql-ha/backup": [tools.backupStep, "mysql-ha/health"],
    "mysql-ha/health": [tools.healthStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "mysql-ha/infrastructure", "mysql-ha/load-infrastructure", "mysql-ha/dns",
  "mysql-ha/base", "mysql-ha/cluster", "mysql-ha/backup", "mysql-ha/health",
  "mysql-ha/cleanup",
];

function create() {
  let wf = workflow({ start: "mysql-ha/start", wireFn });
  wf = progress.advise(wf);
  wf = dryRun.advise(wf, sideEffecting);
  for (const tool of tools.tofuTools) {
    wf = adviceAdd(wf, `mysql-ha/${tool.slice("mysql-ha-".length)}`, "before",
      `io.github.getcolors.mysql-ha.workflow/backend-${tool}`, backendAdvice(tool));
  }
  // `load-infrastructure` runs `tofu init` in the infrastructure stage's
  // own directory, so it needs that stage's backend written first — the
  // same advice, targeted at a different step.
  return adviceAdd(wf, "mysql-ha/load-infrastructure", "before",
    "io.github.getcolors.mysql-ha.workflow/backend-load-infrastructure",
    backendAdvice(tools.infrastructureTool));
}

export const mysqlHaWorkflow = create();
