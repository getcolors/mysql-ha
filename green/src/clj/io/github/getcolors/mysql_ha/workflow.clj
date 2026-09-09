(ns io.github.getcolors.mysql-ha.workflow
  "Application lifecycle around the shared compute library."
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.workflow :as wf]
                        [io.github.getcolors.mysql-ha.ssh :as ssh]
            [io.github.getcolors.mysql-ha.ssh-config :as ssh-config]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def defaults
  {:compute-prevent-destroy true
   :provider-compute validate/default-compute-provider
   :provider-dns "cloudflare"
   :provider-backend "r2"
   :workdir ".colors"})

(def credential-events
  "Events that reach a provider and therefore need credentials. `build` is
  deliberately absent: a fresh checkout with an empty environment must render."
  #{:create :delete :health})

(defn- real-credential-event? [{:keys [event real?]}]
  (boolean (and real? (credential-events event))))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env] (start-step opts env nil))
  ([opts env _]
   (lifecycle/preflight opts
     {:defaults defaults :overlay green-cli/read-pars
      :validators [(fn [_ env _] (validate/env-errors env))
                   (fn [opts _ _] (validate/state-errors opts))
                   (fn [opts _ ctx]
                     (when (and (real-credential-event? ctx) (empty? (validate/state-errors opts))) (validate/secret-errors opts)))
                   (fn [opts _ {:keys [event real?]}]
                     (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                       ["compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete"]))]
      :after-validate (fn [opts _ {:keys [event real?]}]
                        (if (and real? (= :create event)) (ssh-config/preflight! opts)
                            (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    ;; The `~/.ssh/config` block goes before the destroy, the keypair after it.
    ;; A block that outlives its host is stale but harmless; a key that
    ;; predeceases its host locks the operator out of members that still
    ;; exist. Both orders are deliberate — standards/ssh-config.md §4 is
    ;; explicit that they must not be tidied into agreement.
    (case step
      :mysql-ha/start [start-step :mysql-ha/load-infrastructure]
      :mysql-ha/load-infrastructure [tools/load-infrastructure-step :mysql-ha/cleanup]
      :mysql-ha/cleanup [tools/cleanup-step :mysql-ha/ansible-local]
      :mysql-ha/ansible-local [tools/ansible-local-step :mysql-ha/dns]
      :mysql-ha/dns [tools/dns-step :mysql-ha/infrastructure]
      :mysql-ha/infrastructure [tools/infrastructure-step])

    :health
    (case step
      :mysql-ha/start [start-step :mysql-ha/load-infrastructure]
      :mysql-ha/load-infrastructure [tools/load-infrastructure-step :mysql-ha/health]
      :mysql-ha/health [tools/health-step])

    ;; The block is written after compute, where the addresses first exist,
    ;; and before the members are converged (ssh-config.md §4).
    (case step
      :mysql-ha/start [start-step :mysql-ha/infrastructure]
      :mysql-ha/infrastructure [tools/infrastructure-step :mysql-ha/ansible-local]
      :mysql-ha/ansible-local [tools/ansible-local-step :mysql-ha/dns :mysql-ha/base]
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
  [:mysql-ha/infrastructure :mysql-ha/load-infrastructure :mysql-ha/ansible-local
   :mysql-ha/dns :mysql-ha/base :mysql-ha/cluster :mysql-ha/backup
   :mysql-ha/health :mysql-ha/cleanup])

(def workflow
  (-> (wf/workflow {:start :mysql-ha/start :wire-fn wire-fn
                    :next-fn (fn [_ successors opts]
                               (if (or (:mysql-ha/already-destroyed opts) (wf/failed? opts)) []
                                   (mapv #(vector % opts) successors)))})
      progress/advise
      (dry-run/advise side-effecting)
      (wf/advice-add :mysql-ha/dns :before ::backend-dns (backend-advice tools/dns-tool))))
