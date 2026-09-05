"""The lifecycle graph, preflight, and the backend advice each OpenTofu stage
runs behind — the port of io.github.getcolors.mysql-ha.workflow.

Create forks after the infrastructure: Cloudflare and apt have nothing to say
to each other, so `dns` and `base` run in parallel and join at `cluster`.
Joining DNS there rather than leaving it dangling means a bad zone or a
missing token surfaces before any data-plane work starts.

Delete and health both begin by adopting the cluster out of remote state,
because neither can re-derive it. The state is read once, in preflight, so
the Compute Provider Standard's switch guard runs before the credentials are
checked; the read is handed to `load-infrastructure` rather than repeated.
"""

from __future__ import annotations

import os

from blue import dry_run, progress
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow
from package_once_blue import compute_cluster as cluster

from . import ssh, ssh_config, tools, validate

DEFAULTS = {"compute-prevent-destroy": True,
            "provider-compute": validate.default_compute_provider,
            "provider-dns": "cloudflare",
            "provider-backend": "local",
            "workdir": ".colors"}

# Events that reach a provider and therefore need credentials. `build` is
# deliberately absent: a fresh checkout with an empty environment must render.
CREDENTIAL_EVENTS = ("create", "delete", "health")


def _real_credential_event(context: dict) -> bool:
    return bool(context.get("real") and context.get("event") in CREDENTIAL_EVENTS)


async def start_step(original: dict, env: dict | None = None, reader=None) -> dict:
    """Preflight. On a real create, delete or health the compute state is
    read once through `reader` — the package's `tools.state_output` unless a
    test injects another — on the same defaulted and overlaid opts the
    validators see, and only once desired state itself has passed, so the
    reader never renders an invalid colors.yml. The read feeds the switch
    guard here and travels on under `mysql-ha/state` for
    `load-infrastructure` to adopt."""
    reader = reader if reader is not None else tools.state_output
    environment = dict(os.environ if env is None else env)
    overlaid = read_pars({**DEFAULTS, **original}, environment)
    context = {"event": overlaid.get("blue/event"), "real": not overlaid.get("blue/dry-run")}
    state: dict = {}
    if (_real_credential_event(context)
            and not validate.env_errors(environment)
            and not validate.state_errors(overlaid)):
        state = await cluster.read_state(overlaid, reader)

    # The machine key's create matrix and the DigitalOcean preflight run
    # before any template is rendered: an unowned key on disk or at the
    # provider stops the run while stopping is still free. Every other event
    # fills the same template values — a destroy renders before it destroys,
    # a health reaches the members with the key — but checks no key, because
    # the delete's key cleanup runs after the compute destroy.
    async def after(opts, _env, ctx):
        handed = {**opts, "mysql-ha/state": state} if _real_credential_event(ctx) else opts
        if ctx["real"] and ctx["event"] == "create":
            async def recorded(_opts):
                return state.get("params")
            handed = await ssh.ensure_key(handed, recorded)
            if failed(handed):
                return handed
            handed = ssh.preflight(ssh.with_machine_key(handed))
            if failed(handed):
                return handed
            handed = ssh_config.preflight(handed)
            if failed(handed):
                return handed
            return {**handed, "blue/exit": 0}
        return {**ssh.with_machine_key(handed), "blue/exit": 0}

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=environment,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            # Standard §4 before the credentials: a recorded provider that
            # differs from the selected one reports the actionable error, not
            # a missing token for the provider that was just selected.
            lambda o, _e, c: (cluster.provider_validator(
                validate.spec, o, state.get("params"), lambda: validate.secret_errors(o))
                if _real_credential_event(c) else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        # The `~/.ssh/config` block goes before the destroy, the keypair after
        # it. A block that outlives its host is stale but harmless; a key that
        # predeceases its host locks the operator out of members that still
        # exist. Both orders are deliberate — standards/ssh-config.md §4 is
        # explicit that they must not be tidied into agreement.
        return {
            "mysql-ha/start": (start_step, "mysql-ha/load-infrastructure"),
            "mysql-ha/load-infrastructure": (tools.load_infrastructure_step,
                                             "mysql-ha/cleanup"),
            "mysql-ha/cleanup": (tools.cleanup_step, "mysql-ha/ansible-local"),
            "mysql-ha/ansible-local": (tools.ansible_local_step, "mysql-ha/dns"),
            "mysql-ha/dns": (tools.dns_step, "mysql-ha/infrastructure"),
            "mysql-ha/infrastructure": (tools.infrastructure_step, "mysql-ha/ssh-cleanup"),
            "mysql-ha/ssh-cleanup": (ssh.cleanup_step,),
        }.get(step)
    if run_opts.get("blue/event") == "health":
        return {
            "mysql-ha/start": (start_step, "mysql-ha/load-infrastructure"),
            "mysql-ha/load-infrastructure": (tools.load_infrastructure_step,
                                             "mysql-ha/health"),
            "mysql-ha/health": (tools.health_step,),
        }.get(step)
    # The block is written after compute, where the addresses first exist,
    # and before the members are converged (ssh-config.md §4).
    return {
        "mysql-ha/start": (start_step, "mysql-ha/infrastructure"),
        "mysql-ha/infrastructure": (tools.infrastructure_step, "mysql-ha/ansible-local"),
        "mysql-ha/ansible-local": (tools.ansible_local_step,
                                   "mysql-ha/dns", "mysql-ha/base"),
        "mysql-ha/dns": (tools.dns_step, "mysql-ha/cluster"),
        "mysql-ha/base": (tools.base_step, "mysql-ha/cluster"),
        "mysql-ha/cluster": (tools.cluster_step, "mysql-ha/backup"),
        "mysql-ha/backup": (tools.backup_step, "mysql-ha/health"),
        "mysql-ha/health": (tools.health_step,),
    }.get(step)


def backend_advice(tool: str):
    """The state backend of one OpenTofu stage: `tools.backend_advice`, which
    the state reader also runs, so a delete from a fresh clone finds its
    state."""
    return tools.backend_advice(tool)


side_effecting = ["mysql-ha/infrastructure", "mysql-ha/load-infrastructure",
                  "mysql-ha/ansible-local", "mysql-ha/dns", "mysql-ha/base",
                  "mysql-ha/cluster", "mysql-ha/backup", "mysql-ha/health",
                  "mysql-ha/cleanup", "mysql-ha/ssh-cleanup"]


def create_workflow():
    wf = workflow(start="mysql-ha/start", wire_fn=wire_fn)
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting)
    for tool in tools.tofu_tools:
        wf = advice_add(wf, f"mysql-ha/{tool[len('mysql-ha-'):]}", "before",
                        f"io.github.getcolors.mysql-ha.workflow/backend-{tool}",
                        backend_advice(tool))
    # `load-infrastructure` runs `tofu init` in the infrastructure stage's
    # own directory, so it needs that stage's backend written first — the
    # same advice, targeted at a different step.
    return advice_add(wf, "mysql-ha/load-infrastructure", "before",
                      "io.github.getcolors.mysql-ha.workflow/backend-load-infrastructure",
                      backend_advice(tools.infrastructure_tool))


mysql_ha_workflow = create_workflow()
