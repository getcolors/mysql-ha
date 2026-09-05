(ns io.github.getcolors.mysql-ha.workflow
  "The lifecycle graph, preflight, and the backend advice each OpenTofu stage
  runs behind.

  Create forks after the infrastructure: Cloudflare and apt have nothing to say
  to each other, so `dns` and `base` run in parallel and join at `cluster`.
  Joining DNS there rather than leaving it dangling means a bad zone or a
  missing token surfaces before any data-plane work starts.

  Delete and health both begin by adopting the cluster out of remote state,
  because neither can re-derive it. The state is read once, in preflight, so
  the Compute Provider Standard's switch guard runs before the credentials
  are checked; the read is handed to `load-infrastructure` rather than
  repeated."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-backend "local"
   :workdir ".colors"})

(def credential-events
  "Events that reach a provider and therefore need credentials. `build` is
  deliberately absent: a fresh checkout with an empty environment must render."
  #{:create :delete :health})

(defn- real-credential-event? [{:keys [event real?]}]
  (boolean (and real? (credential-events event))))

(defn start-step
  "Preflight. On a real create, delete or health the compute state is read
  once through `reader` — the package's `tools/state-output` unless a test
  injects another — on the same defaulted and overlaid opts the validators
  see, and only once desired state itself has passed, so the reader never
  renders an invalid colors.yml. The read feeds the switch guard here and
  travels on under `:mysql-ha/state` for `load-infrastructure` to adopt."
  ([opts] (start-step opts (System/getenv)))
  ([opts env] (start-step opts env tools/state-output))
  ([opts env reader]
   (let [overlaid (green-cli/read-pars (merge defaults opts) env)
         context {:event (:green/event overlaid) :real? (lifecycle/real-run? overlaid)}
         state (when (and (real-credential-event? context)
                          (empty? (validate/env-errors env))
                          (empty? (validate/state-errors overlaid)))
                 (cluster/read-state overlaid reader))]
     (lifecycle/preflight
      opts
      {:defaults defaults
       :overlay green-cli/read-pars
       :validators
       [(fn [_ env _] (validate/env-errors env))
        (fn [opts _ _] (validate/state-errors opts))
        ;; Standard §4 before the credentials: a recorded provider that differs
        ;; from the selected one reports the actionable error, not a missing
        ;; token for the provider that was just selected.
        (fn [opts _ ctx]
          (when (real-credential-event? ctx)
            (cluster/provider-validator validate/spec opts (:params state)
                                        #(validate/secret-errors opts))))
        (fn [opts _ {:keys [event real?]}]
          (when (and real? (= :delete event) (:compute-prevent-destroy opts))
            [(str "compute destruction is protected; set "
                  (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
       :after-validate
       (fn [opts _ ctx]
         (cond-> (assoc opts :green/exit 0)
           (real-credential-event? ctx) (assoc :mysql-ha/state state)))}
      env))))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    (case step
      :mysql-ha/start [start-step :mysql-ha/load-infrastructure]
      :mysql-ha/load-infrastructure [tools/load-infrastructure-step :mysql-ha/cleanup]
      :mysql-ha/cleanup [tools/cleanup-step :mysql-ha/dns]
      :mysql-ha/dns [tools/dns-step :mysql-ha/infrastructure]
      :mysql-ha/infrastructure [tools/infrastructure-step])

    :health
    (case step
      :mysql-ha/start [start-step :mysql-ha/load-infrastructure]
      :mysql-ha/load-infrastructure [tools/load-infrastructure-step :mysql-ha/health]
      :mysql-ha/health [tools/health-step])

    (case step
      :mysql-ha/start [start-step :mysql-ha/infrastructure]
      :mysql-ha/infrastructure [tools/infrastructure-step :mysql-ha/dns :mysql-ha/base]
      :mysql-ha/dns [tools/dns-step :mysql-ha/cluster]
      :mysql-ha/base [tools/base-step :mysql-ha/cluster]
      :mysql-ha/cluster [tools/cluster-step :mysql-ha/backup]
      :mysql-ha/backup [tools/backup-step :mysql-ha/health]
      :mysql-ha/health [tools/health-step])))

(defn backend-advice
  "The state backend of one OpenTofu stage: `tools/backend-advice`, which the
  state reader also runs, so a delete from a fresh clone finds its state."
  [tool]
  (tools/backend-advice tool))

(def side-effecting
  [:mysql-ha/infrastructure :mysql-ha/load-infrastructure :mysql-ha/dns
   :mysql-ha/base :mysql-ha/cluster :mysql-ha/backup :mysql-ha/health
   :mysql-ha/cleanup])

(def workflow
  (-> (reduce (fn [w tool]
                (wf/advice-add w (keyword "mysql-ha" (subs tool (count "mysql-ha-")))
                               :before (keyword "io.github.getcolors.mysql-ha.workflow"
                                                (str "backend-" tool))
                               (backend-advice tool)))
              (-> (wf/workflow {:start :mysql-ha/start :wire-fn wire-fn})
                  progress/advise
                  (dry-run/advise side-effecting))
              tools/tofu-tools)
      ;; `load-infrastructure` runs `tofu init` in the infrastructure stage's
      ;; own directory, so it needs that stage's backend written first — the
      ;; same advice, targeted at a different step.
      (wf/advice-add :mysql-ha/load-infrastructure
                     :before ::backend-load-infrastructure
                     (backend-advice tools/infrastructure-tool))))
