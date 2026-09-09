
import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";

import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-backend": "r2",
  workdir: ".colors",
};

// Events that reach a provider and therefore need credentials. `build` is
// deliberately absent: a fresh checkout with an empty environment must render.
export const credentialEvents = ["create", "delete", "health"];

const realCredentialEvent = ({ event, real }: PreflightContext): boolean =>
  real && credentialEvents.includes(String(event));

export async function startStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts>{
 return preflight(opts,{defaults,overlay:readPars,validators:[(_o,e)=>validate.envErrors(e),o=>validate.stateErrors(o),
  (o,_e,c)=>realCredentialEvent(c)&&!validate.stateErrors(o).length?validate.secretErrors(o):[],
  (o,_e,c)=>c.real&&c.event==='delete'&&o['compute-prevent-destroy']?['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete']:[]],
 afterValidate:async(current,_e,c)=>c.real&&c.event==='create'?sshConfig.preflight(current):{...ssh.withMachineKey(current),'red/exit':0}},env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    // The `~/.ssh/config` block goes before the destroy, the keypair after it.
    // A block that outlives its host is stale but harmless; a key that
    // predeceases its host locks the operator out of members that still exist.
    // Both orders are deliberate — standards/ssh-config.md §4 is explicit that
    // they must not be tidied into agreement.
    const graph: Record<string, WireDecl> = {
      "mysql-ha/start": [startStep, "mysql-ha/load-infrastructure"],
      "mysql-ha/load-infrastructure": [tools.loadInfrastructureStep, "mysql-ha/cleanup"],
      "mysql-ha/cleanup": [tools.cleanupStep, "mysql-ha/ansible-local"],
      "mysql-ha/ansible-local": [tools.ansibleLocalStep, "mysql-ha/dns"],
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
  // The block is written after compute, where the addresses first exist, and
  // before the members are converged (ssh-config.md §4).
  const graph: Record<string, WireDecl> = {
    "mysql-ha/start": [startStep, "mysql-ha/infrastructure"],
    "mysql-ha/infrastructure": [tools.infrastructureStep, "mysql-ha/ansible-local"],
    "mysql-ha/ansible-local": [tools.ansibleLocalStep, "mysql-ha/dns", "mysql-ha/base"],
    "mysql-ha/dns": [tools.dnsStep, "mysql-ha/cluster"],
    "mysql-ha/base": [tools.baseStep, "mysql-ha/cluster"],
    "mysql-ha/cluster": [tools.clusterStep, "mysql-ha/backup"],
    "mysql-ha/backup": [tools.backupStep, "mysql-ha/health"],
    "mysql-ha/health": [tools.healthStep],
  };
  return graph[step];
}

// The state backend of one OpenTofu stage: `tools.backendAdvice`, which the
// state reader also runs, so a delete from a fresh clone finds its state.
export function backendAdvice(tool: string) {
  return tools.backendAdvice(tool);
}

export const sideEffecting = [
  "mysql-ha/infrastructure", "mysql-ha/load-infrastructure", "mysql-ha/ansible-local",
  "mysql-ha/dns", "mysql-ha/base", "mysql-ha/cluster", "mysql-ha/backup",
  "mysql-ha/health", "mysql-ha/cleanup", "mysql-ha/ssh-cleanup",
];

function create(){
 let wf=workflow({start:'mysql-ha/start',wireFn,nextFn:(_step,next,opts)=>opts['mysql-ha/already-destroyed']||failed(opts)?[]:(next??[]).map(step=>[step,opts])});
 wf=progress.advise(wf);wf=dryRun.advise(wf,sideEffecting);
 return adviceAdd(wf,'mysql-ha/dns','before','mysql-ha/backend-dns',backendAdvice(tools.dnsTool));
}

export const mysqlHaWorkflow = create();
