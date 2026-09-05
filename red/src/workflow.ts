// The lifecycle graph, preflight, and the backend advice each OpenTofu stage
// runs behind — the port of io.github.getcolors.mysql-ha.workflow.
//
// Create forks after the infrastructure: Cloudflare and apt have nothing to say
// to each other, so `dns` and `base` run in parallel and join at `cluster`.
// Joining DNS there rather than leaving it dangling means a bad zone or a
// missing token surfaces before any data-plane work starts.
//
// Delete and health both begin by adopting the cluster out of remote state,
// because neither can re-derive it. The state is read once, in preflight, so
// the Compute Provider Standard's switch guard runs before the credentials are
// checked; the read is handed to `load-infrastructure` rather than repeated.

import { parName, readPars } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "compute-prevent-destroy": true,
  "provider-compute": validate.defaultComputeProvider,
  "provider-dns": "cloudflare",
  "provider-backend": "local",
  workdir: ".colors",
};

// Events that reach a provider and therefore need credentials. `build` is
// deliberately absent: a fresh checkout with an empty environment must render.
export const credentialEvents = ["create", "delete", "health"];

const realCredentialEvent = ({ event, real }: PreflightContext): boolean =>
  real && credentialEvents.includes(String(event));

// Preflight. On a real create, delete or health the compute state is read
// once through `reader` — the package's `tools.stateOutput` unless a test
// injects another — on the same defaulted and overlaid opts the validators
// see, and only once desired state itself has passed, so the reader never
// renders an invalid colors.yml. The read feeds the switch guard here and
// travels on under `mysql-ha/state` for `load-infrastructure` to adopt.
export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
  reader: compute.StateReader = tools.stateOutput,
): Promise<Opts> {
  const overlaid = readPars({ ...defaults, ...opts }, env);
  const context: PreflightContext = {
    event: typeof overlaid["red/event"] === "string" ? overlaid["red/event"] as string : undefined,
    real: !overlaid["red/dry-run"],
  };
  const state: compute.StateRead =
    realCredentialEvent(context)
      && validate.envErrors(env).length === 0
      && validate.stateErrors(overlaid).length === 0
      ? await computeCluster.readState(overlaid, reader)
      : {};
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      // Standard §4 before the credentials: a recorded provider that differs
      // from the selected one reports the actionable error, not a missing
      // token for the provider that was just selected.
      (current, _environment, ctx) => (realCredentialEvent(ctx)
        ? computeCluster.providerValidator(validate.spec, current, state.params, () => validate.secretErrors(current))
        : []),
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    // The machine key's create matrix and the DigitalOcean preflight run
    // before any template is rendered: an unowned key on disk or at the
    // provider stops the run while stopping is still free. Every other event
    // fills the same template values — a destroy renders before it destroys, a
    // health reaches the members with the key — but checks no key, because the
    // delete's key cleanup runs after the compute destroy.
    afterValidate: async (current, _environment, ctx) => {
      const handed = realCredentialEvent(ctx) ? { ...current, "mysql-ha/state": state } : current;
      if (ctx.real && ctx.event === "create") {
        let next = await ssh.ensureKey(handed, async () => state.params);
        if (failed(next)) return next;
        next = await ssh.preflight(ssh.withMachineKey(next));
        if (!failed(next)) next = sshConfig.preflight(next);
        return failed(next) ? next : { ...next, "red/exit": 0 };
      }
      return { ...ssh.withMachineKey(handed), "red/exit": 0 };
    },
  }, env);
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
      "mysql-ha/infrastructure": [tools.infrastructureStep, "mysql-ha/ssh-cleanup"],
      "mysql-ha/ssh-cleanup": [ssh.cleanupStep],
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
