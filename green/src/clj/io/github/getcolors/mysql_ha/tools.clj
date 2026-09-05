(ns io.github.getcolors.mysql-ha.tools
  "OpenTofu and Ansible stages for the three-member Group Replication cluster.

  Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
  reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
  One Ansible directory holds every playbook, because they share an inventory
  and a set of rendered scripts and splitting them across directories would
  duplicate both.

  The cluster itself — which machines exist, at which addresses — is the
  Compute Cluster Standard's `params`, adopted through ONCE's
  `compute-cluster` namespace and carried under `:once/cluster`. This
  package puts its own facts inside it: `reserved_ip`, `vpc_id` and
  `vpc_ip_range` at the top level, a `droplet_id` on every node."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.mysql-ha.ssh :as ssh]
            [io.github.getcolors.mysql-ha.ssh-config :as ssh-config]
            [io.github.getcolors.mysql-ha.utils :as utils]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def infrastructure-tool "mysql-ha-infrastructure")
(def dns-tool "mysql-ha-dns")
(def ansible-local-tool "mysql-ha-ansible-local")
(def ansible-tool "mysql-ha-ansible")
(def tofu-tools [infrastructure-tool dns-tool])

(def ^:private root "io.github.getcolors.mysql_ha.tools")
(def ^:private template-opts sc/preserve-jinja-delimiters)

(defn template [path file] (keyword (str root "." path) file))
(defn spec [template target data]
  {:template template :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))
(defn tool-dir [opts tool] (utils/tool-dir opts tool))

(defn credential-env [opts & slots]
  (provider-ops/tool-env validate/providers opts
                         (conj (vec slots) :provider-backend)))

(defn backend-advice
  "The state backend of one OpenTofu stage, written before the stage runs.
  `dir-fn` and `key-fn` are explicit so the state addresses cannot move."
  [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(defn- refuse [opts errors]
  (assoc opts :green/exit 1 :green/err (str/join "\n" errors)))

;; ---------------------------------------------------------------------------
;; infrastructure

(def fallback-outputs
  "Stand-ins for the cluster facts beside the nodes, so `build` and
  `--dry-run` render the same shape of file as a real run without ever
  reading state or contacting a provider. Documentation-range values, so a
  rendered artifact that leaked into a real run would fail loudly rather
  than reach something. The nodes themselves are ONCE's fallbacks, cut from
  `spec`'s subnet at offset 11."
  {:reserved_ip "192.0.2.10"
   :vpc_id "00000000-0000-0000-0000-000000000000"
   :vpc_ip_range "10.110.0.0/20"})

(defn- fallback-droplet-id
  "The droplet id a build renders for member `ordinal`; a real run reads
  every id from state."
  [ordinal]
  (+ 100000000 ordinal))

(defn infrastructure-specs [opts]
  ;; The machine-key paths are filled here as well as in preflight, so the
  ;; template renders the same bytes whichever step scaffolds it — the state
  ;; reader renders it as a build, and a test may render it alone.
  (let [opts (ssh/with-machine-key opts)
        dir (tool-dir opts infrastructure-tool)
        data (assoc opts
                    :node-count (utils/node-count opts)
                    :digitalocean-ssh-sources-json
                    (json/generate-string (compute/cidrs opts :digitalocean-ssh-sources))
                    :digitalocean-client-sources-json
                    (json/generate-string (compute/cidrs opts :digitalocean-client-sources)))]
    [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)]))

(defn output-params
  "The compute stage's `params` output, as ONCE reads it: keywordized, the
  underscores kept; nil when the apply reported none."
  [result]
  (cluster/output-params {:tofu/outputs (:mysql-ha/outputs result)}))

(defn- non-blank? [v]
  (or (integer? v) (and (string? v) (not (str/blank? v)))))

(defn params-errors
  "The extension keys this package puts inside `params`, which ONCE
  preserves but does not read: a non-blank `reserved_ip` and `vpc_id`, a
  canonical `vpc_ip_range`, and a non-blank `droplet_id` on every node. A
  real run is refused without them; the legacy translation is held to the
  same rule."
  [params]
  (let [missing-ids (for [n (:nodes params)
                          :when (not (non-blank? (:droplet_id n)))]
                      (cluster/node-id-str n))]
    (vec
     (concat
      (for [k [:reserved_ip :vpc_id] :when (not (non-blank? (get params k)))]
        (str "compute state carries no " (name k)))
      (cond
        (not (non-blank? (:vpc_ip_range params)))
        ["compute state carries no vpc_ip_range"]
        (not (cluster/ipv4-network (:vpc_ip_range params)))
        [(str "compute state vpc_ip_range " (pr-str (:vpc_ip_range params))
              " is not a canonical IPv4 network such as 10.40.0.0/24")])
      (when (seq missing-ids)
        [(str "compute state carries no droplet_id for " (str/join ", " missing-ids))])))))

(defn- checked
  "`opts` once the adopted cluster passes `params-errors`, or the refusal."
  [opts]
  (let [errors (some-> (:once/cluster opts) params-errors)]
    (if (seq errors) (refuse opts errors) opts)))

(defn resolve-infrastructure
  "What the infrastructure stage hands on after its apply: `result` as it is
  on a failure, a delete or a build, and otherwise ONCE's `resolved-cluster`
  over the apply's `params` output — nil outputs and a partial cluster are
  refused there — checked against `params-errors`. Pure, so the wiring is
  testable without an apply."
  [opts result]
  (cond
    (wf/failed? result) result
    (contains? #{:delete :build} (:green/event opts)) result
    :else (let [resolved (cluster/resolved-cluster validate/spec opts result {}
                                                   (output-params result))]
            (if (wf/failed? resolved) resolved (checked resolved)))))

(defn infrastructure-step [opts]
  (resolve-infrastructure
   opts
   (tofu/tofu-with-spec opts (infrastructure-specs opts)
                        {:dir (tool-dir opts infrastructure-tool)
                         :env (credential-env opts :provider-compute)
                         :output-key :mysql-ha/outputs})))

(defn- step-error [dir label {:keys [out err]}]
  (ex-info (str label " failed: " (or (not-empty err) (not-empty out) "(no output)"))
           {:dir dir}))

(defn legacy-params
  "A state written before this package recorded `params`: the parallel
  `node_public_ips`, `node_private_ips` and `node_droplet_ids` lists, zipped
  into the nodes the standard describes, with `reserved_ip`, `vpc_id` and
  `vpc_ip_range` copied and the names this package has always given its
  members. Refused, as the SDK's step error carrying `dir`, when the three
  lists disagree with each other or with `cluster-nodes` — guessing which
  droplet is which is how a delete destroys around a member — and when no
  `reserved_ip` was recorded. A missing `vpc_id` or `vpc_ip_range` is
  `params-errors`' to refuse, the same way for a legacy and a recorded state."
  [opts outputs dir]
  (let [publics (vec (:node_public_ips outputs))
        privates (vec (:node_private_ips outputs))
        ids (vec (:node_droplet_ids outputs))
        n (:cluster-nodes opts)]
    (when-not (= n (count publics) (count privates) (count ids))
      (throw (ex-info (str "legacy state lists " (count publics) " public addresses, "
                           (count privates) " private addresses and " (count ids)
                           " droplet ids; refusing to guess the cluster")
                      {:dir dir})))
    (when-not (non-blank? (:reserved_ip outputs))
      (throw (ex-info "legacy state carries no reserved_ip" {:dir dir})))
    {:provider validate/default-compute-provider
     :reserved_ip (:reserved_ip outputs)
     :vpc_id (:vpc_id outputs)
     :vpc_ip_range (:vpc_ip_range outputs)
     :nodes (mapv (fn [i]
                    {:index i
                     :role nil
                     :name (utils/node-name opts (inc i))
                     :ip (nth publics i)
                     :vpc_ip (nth privates i)
                     :droplet_id (nth ids i)
                     :user "root"
                     :sudoer "root"})
                  (range n))}))

(defn state-output
  "The reader ONCE's `read-state` takes: the compute `params` recorded in
  the infrastructure state, nil when the state is readable and holds
  nothing, and the legacy translation when it holds only the pre-adoption
  outputs. Delete and health both need the cluster and neither can re-derive
  it — nor can a fresh clone, so the stage is rendered, its backend written
  and initialized here, before the read. A failed initialization throws the
  SDK's step error carrying `:dir`, the shape `green.tofu/outputs` throws on
  an unreadable backend; `read-state` reports both fail-closed."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        env (merge (into {} (System/getenv))
                   (credential-env opts :provider-compute))]
    (sc/scaffold (assoc opts :green/event :build) (infrastructure-specs opts))
    ((backend-advice infrastructure-tool) opts)
    (let [init (process/run ["tofu" (str "-chdir=" dir) "init" "-input=false" "-no-color"]
                            {:extra-env env})]
      (when-not (zero? (:exit init))
        (throw (step-error dir "infrastructure state initialization" init))))
    (let [outputs (tofu/outputs dir env)]
      (cond
        (contains? outputs :params) (walk/keywordize-keys (:params outputs))
        (empty? outputs) nil
        :else (legacy-params opts outputs dir)))))

(def no-cluster-message
  "The health refusal when the state is readable and records no cluster: a
  real run never checks the documentation addresses."
  "the infrastructure state records no cluster; refusing to check the documentation addresses")

(defn load-infrastructure-step
  "Adopt the cluster out of remote state without planning or changing
  anything: ONCE's `adopt-state` over the read `start-step` handed on under
  `:mysql-ha/state`, or a fresh read when nothing was. An unreadable backend
  and a partial cluster fail closed; the adopted `params` must then pass
  `params-errors`. A readable state without a cluster means there is nothing
  to clean up on a delete and nothing to check on a health."
  [opts]
  (let [event (:green/event opts)
        state (or (:mysql-ha/state opts) (cluster/read-state opts state-output))
        adopted (cluster/adopt-state validate/spec (dissoc opts :mysql-ha/state) event state)
        present? (contains? adopted :once/cluster)]
    (cond
      (wf/failed? adopted) adopted
      (and (not present?) (= :health event)) (refuse adopted [no-cluster-message])
      :else (let [checked (checked adopted)]
              (if (wf/failed? checked)
                checked
                (assoc checked :mysql-ha/infrastructure-present? present?))))))

;; ---------------------------------------------------------------------------
;; shared template data

(defn- cluster-nodes
  "ONCE's nodes for this deployment: the adopted `params.nodes` on a real
  run, the fallbacks on a build — renamed to what this package has always
  called its members and given a documentation droplet id, so the rendered
  inventory is byte-identical to what it was."
  [opts]
  (let [params (:once/cluster opts)
        nodes (cluster/nodes validate/spec opts params)]
    (if (some? params)
      nodes
      (mapv (fn [{:keys [index] :as node}]
              (let [ordinal (inc index)]
                (assoc node
                       :name (utils/node-name opts ordinal)
                       :droplet_id (fallback-droplet-id ordinal))))
            nodes))))

(defn nodes
  "One map per member, in ordinal order: desired state's derivations over
  the node ONCE reports. Pure: given the same opts it is the same vector,
  which is what makes the inventory and the goldens deterministic."
  [opts]
  (mapv (fn [{:keys [index name ip vpc_ip droplet_id]}]
          (let [ordinal (inc index)]
            {:ordinal ordinal
             :name name
             :host (utils/node-host opts ordinal)
             :public-ip ip
             :private-ip vpc_ip
             :droplet-id droplet_id
             :server-id (utils/server-id ordinal)
             :connection-server-id (utils/connection-server-id ordinal)}))
        (cluster-nodes opts)))

(defn group-seeds
  "`group_replication_group_seeds`: every member's private address on the group
  port. Every member gets the same list, so a joining member can reach the
  group through whichever seed is up."
  [opts]
  (str/join "," (map #(str (:private-ip %) ":" (:mysql-group-port opts))
                     (nodes opts))))

(defn private-key-file
  "The private key every play reaches the members with: the generated key's
  path in keygen mode (the build placeholder on a build or a dry-run), the
  operator's `digitalocean-ssh-private-key` in opt-out mode."
  [data]
  (if (validate/keygen? data)
    (str (:ssh-private-key-path data))
    (str (:digitalocean-ssh-private-key data))))

(defn data-fn
  "Template data: desired state over the fallback cluster facts, with the
  adopted cluster's `reserved_ip`, `vpc_id` and `vpc_ip_range` winning on a
  real run, and the machine-key paths keygen mode owns."
  [opts]
  (let [opts (ssh/with-machine-key opts)
        data (merge fallback-outputs opts
                    (select-keys (:once/cluster opts) (keys fallback-outputs)))]
    (assoc data
           :node-count (utils/node-count opts)
           :backup-prefix (utils/backup-prefix opts)
           :group-seeds (group-seeds data)
           :cluster-record (utils/record-name (:cluster-host opts)))))

(defn inventory
  "Ansible inventory as JSON. Every member is in `mysql`; `bootstrap` names
  member one, which is only ever used to pick who bootstraps an empty group
  — it carries no meaning once the group exists."
  [opts]
  (let [data (data-fn opts)
        key-file (private-key-file data)
        members (nodes data)
        hosts (into (sorted-map)
                    (map (fn [{:keys [name ordinal public-ip private-ip droplet-id
                                      server-id connection-server-id host]}]
                           [name (into (sorted-map)
                                       {:ansible_host public-ip
                                        :ansible_user "root"
                                        :ansible_ssh_private_key_file key-file
                                        :node_ordinal ordinal
                                        :node_host host
                                        :private_ip private-ip
                                        :droplet_id droplet-id
                                        :server_id server-id
                                        :connection_server_id connection-server-id})]))
                    members)]
    (json/generate-string
     {:all {:children
            {:mysql {:hosts hosts}
             :bootstrap {:hosts (select-keys hosts [(:name (first members))])}}}}
     {:pretty true})))

;; ---------------------------------------------------------------------------
;; ssh config (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. Addresses are run-time facts and reach
  the play as extra-vars instead, so the rendered playbook carries no IP and
  is identical on every workstation (SSH Config Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)
         :host-alias (ssh-config/host-alias opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ssh-config-hosts
  "The `~/.ssh/config` entries, as data the play loops over: the bare profile
  pointing at node 0 (the spec's entry), then one alias per member. ONCE's
  (Compute Cluster Standard §6)."
  [opts]
  (cluster/ssh-config-hosts validate/spec opts (cluster-nodes opts)))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them. Skipped on a delete whose
  state records no cluster: there is no block to withdraw."
  [opts]
  (if (and (= :delete (:green/event opts))
           (false? (:mysql-ha/infrastructure-present? opts)))
    (assoc opts :green/exit 0)
    (ansible/ansible-with-spec
     opts
     {:dir (tool-dir opts ansible-local-tool)
      :inventory "inventory.ini"
      :playbooks {:create "main.yml" :delete "main.yml"}
      :extra-vars {:host_alias (ssh-config/host-alias opts)
                   :ssh_hosts (ssh-config-hosts opts)
                   :block_state (if (= :delete (:green/event opts)) "absent" "present")}}
     (ansible-local-specs opts))))

;; ---------------------------------------------------------------------------
;; dns

(defn dns-specs [opts]
  (let [dir (tool-dir opts dns-tool)
        base (data-fn opts)
        data (assoc base
                    :node-records-json
                    (json/generate-string
                     (into (sorted-map)
                           (map (fn [{:keys [host public-ip]}]
                                  [(utils/record-name host) public-ip]))
                           (nodes base))))]
    [(spec (template "dns" "main.tf") (str dir "/main.tf") data)]))

(defn dns-step [opts]
  (tofu/tofu-with-spec opts (dns-specs opts)
                       {:dir (tool-dir opts dns-tool)
                        :env (credential-env opts :provider-dns)
                        :output-key :mysql-ha/dns-outputs}))

;; ---------------------------------------------------------------------------
;; ansible

(def ^:private playbooks
  ["base.yml" "cluster.yml" "backup.yml" "health.yml" "cleanup.yml"])

(def ^:private node-files
  "Everything copied onto a member. Credentials are deliberately absent: the
  three files that hold one (`rclone.conf`, `binlog-client.cnf`,
  `secrets.env`) are written by Ansible from `lookup('env', ...)` under
  `no_log`, so no secret is ever rendered into the work directory."
  ["mysql-ha-lib" "mysql-ha-endpoint" "mysql-ha-heartbeat" "mysql-ha-snapshot"
   "mysql-ha-binlog-archive" "mysql-ha-binlog-upload" "mysql-ha-restore-check"
   "mysql-ha-health" "mysqld.cnf" "verify.cnf" "apparmor-local" "node.env"])

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool)
        data (data-fn opts)]
    (concat
     [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)]
     (map #(spec (template "ansible" %) (str dir "/" %) data) playbooks)
     (map #(spec (template "ansible.files" %) (str dir "/files/" %) data) node-files)
     [(raw-spec (str dir "/inventory.json") (inventory opts))])))

(defn- ansible-config [opts playbook recap-key]
  {:dir (tool-dir opts ansible-tool)
   :inventory "inventory.json"
   :playbooks {:create playbook :delete playbook}
   :host-key-checking false
   :recap-key recap-key})

(defn ansible-render-step
  "Render the whole Ansible directory once, so every later stage runs against
  one materialized tree rather than re-rendering per playbook."
  [opts]
  (sc/scaffold opts (ansible-specs opts)))

(defn- playbook-step [opts playbook recap-key]
  (if (= :build (:green/event opts))
    (sc/scaffold opts (ansible-specs opts))
    (ansible/ansible-step (sc/scaffold (assoc opts :green/event :create)
                                       (ansible-specs opts))
                          (ansible-config opts playbook recap-key))))

(defn base-step [opts]
  (-> (playbook-step opts "base.yml" :mysql-ha/base-recap)
      (assoc :green/event (:green/event opts))))

(defn cluster-step [opts]
  (-> (playbook-step opts "cluster.yml" :mysql-ha/cluster-recap)
      (assoc :green/event (:green/event opts))))

(defn backup-step [opts]
  (-> (playbook-step opts "backup.yml" :mysql-ha/backup-recap)
      (assoc :green/event (:green/event opts))))

(defn health-step [opts]
  (-> (playbook-step opts "health.yml" :mysql-ha/health-recap)
      (assoc :green/event (:green/event opts))))

(defn cleanup-step
  "Stop the managed units before the droplets go away. Skipped when the
  infrastructure is already gone, because there is nothing to reach."
  [opts]
  (if (false? (:mysql-ha/infrastructure-present? opts))
    (assoc opts :green/exit 0)
    (ansible/ansible-with-spec
     opts (ansible-config opts "cleanup.yml" :mysql-ha/cleanup-recap)
     (ansible-specs opts))))
