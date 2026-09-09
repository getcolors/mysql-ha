(ns io.github.getcolors.mysql-ha.tools
  "Application stages fed by colors-compute."
  (:require [cheshire.core :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.mysql-ha.compute :as compute]
            [io.github.getcolors.compute-orchestration :as orchestration]
            [io.github.getcolors.compute-planning :as planning]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.compute-endpoint :as endpoint]
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

(defn- compute-json [value indent]
  (let [padding #(apply str (repeat % " "))]
    (cond
      (map? value) (if (empty? value) "{}"
                      (str "{\n" (str/join ",\n" (for [[key item] (sort-by key value)]
                                                       (str (padding (+ indent 2)) (json/generate-string key) ": " (compute-json item (+ indent 2)))))
                           "\n" (padding indent) "}"))
      (sequential? value) (if (empty? value) "[]"
                              (str "[\n" (str/join ",\n" (map #(str (padding (+ indent 2)) (compute-json % (+ indent 2))) value)) "\n" (padding indent) "]"))
      :else (json/generate-string value))))

(defn infrastructure-step [opts]
  (try
    (let [planning? (or (= :build (:green/event opts)) (:green/dry-run opts))
          result (if planning?
                   (planning/plan-deployment opts (compute/topology opts) (compute/requirements opts))
                   (orchestration/orchestrate opts (compute/topology opts) (compute/requirements opts)))]
      (when planning?
        (doseq [[stage documents] (cons ["shared" (get-in result [:documents :shared])]
                                      (map (fn [[id documents]] [(str "nodes/" id) documents]) (get-in result [:documents :nodes])))
                [filename document] documents]
          (let [target (io/file (tool-dir opts infrastructure-tool) stage filename)]
            (io/make-parents target)
            (spit target (str (compute-json document 0) "\n")))))
      (if-not (contains? #{"ready" "planned" "destroyed"} (:status result))
        (assoc opts :green/exit 1 :green/err "compute lifecycle refused; legacy monolithic state requires explicit migration")
        (cond-> (assoc opts :green/exit 0)
          (:cluster result) (assoc :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result))
          (get-in result [:key :private_key_path])
          (assoc :ssh-private-key-path (if planning? (str/replace (get-in result [:key :private_key_path]) "$HOME/.ssh" "/home/build-placeholder/.ssh") (get-in result [:key :private_key_path]))))))
    (catch Exception _ (assoc opts :green/exit 1 :green/err "compute lifecycle refused; legacy monolithic state requires explicit migration"))))

(defn load-infrastructure-step [opts]
  (if (or (= :build (:green/event opts)) (:green/dry-run opts)) (infrastructure-step opts)
      (let [result (inspection/read-deployment opts)]
        (case (:status result)
          "destroyed" (if (= :delete (:green/event opts)) (assoc opts :mysql-ha/already-destroyed true :green/exit 0) (refuse opts ["compute inventory unavailable"]))
          "present" (cond-> (assoc opts :colors-compute/cluster (:cluster result) :colors-compute/shared (:shared result) :mysql-ha/infrastructure-present? true :green/exit 0)
                      (get-in result [:key :private_key_path]) (assoc :ssh-private-key-path (get-in result [:key :private_key_path])))
          (refuse opts ["compute state unavailable; legacy monolithic state requires explicit migration"])))))

(defn- cluster-nodes [opts] (compute/resolved opts))

(defn nodes
  "One map per member, in ordinal order: desired state's derivations over
  the node ONCE reports. Pure: given the same opts it is the same vector,
  which is what makes the inventory and the goldens deterministic."
  [opts]
  (mapv (fn [{:keys [index name ip vpc_ip provider_id user]}]
          (let [_ (when-not provider_id (throw (ex-info "compute provider identity unavailable" {})))
                ordinal (inc index)]
            {:ordinal ordinal
             :name name
             :host (utils/node-host opts ordinal)
             :public-ip ip
             :private-ip vpc_ip
             :uid provider_id
             :user user
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

(defn private-key-file [opts] (or (:ssh-private-key-path opts) ""))
(defn data-fn [opts]
  (let [opts (ssh/with-machine-key opts)
        shared (or (:colors-compute/shared opts)
                   (when (or (= :build (:green/event opts)) (:green/dry-run opts))
                     (:shared (planning/plan-deployment opts (compute/topology opts) (compute/requirements opts)))))
        facts (:params shared)
        _ (when-not (and (:network_cidr facts) (:endpoint_ip facts))
            (throw (ex-info "compute shared network or reserved endpoint unavailable" {})))
        data (assoc opts :endpoint-credentials (:credentials (endpoint/endpoint-agent (:provider-compute opts)))
                         :vpc_ip_range (:network_cidr facts) :reserved_ip (:endpoint_ip facts))]
    (assoc data :node-count (utils/node-count opts) :backup-prefix (utils/backup-prefix opts)
                :group-seeds (group-seeds data) :cluster-record (utils/record-name (:cluster-host opts)))))

(defn inventory
  "Ansible inventory as JSON. Every member is in `mysql`; `bootstrap` names
  member one, which is only ever used to pick who bootstraps an empty group
  — it carries no meaning once the group exists."
  [opts]
  (let [data (data-fn opts)
        key-file (private-key-file data)
        members (nodes data)
        hosts (into (sorted-map)
                    (map (fn [{:keys [name ordinal public-ip private-ip uid user
                                      server-id connection-server-id host]}]
                           [name (into (sorted-map)
                                       {:ansible_host public-ip
                                        :ansible_user user
                                        :ansible_ssh_private_key_file key-file
                                        :node_ordinal ordinal
                                        :node_host host
                                        :private_ip private-ip
                                        :node_uid uid
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
         :ssh-config-identity-file (if (validate/keygen? opts) (ssh-config/identity-file opts) (or (:ssh-private-key-path opts) ""))
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
  (let [nodes (cluster-nodes opts)] (into [(assoc (first nodes) :name (:profile opts))] (map #(assoc % :name (str (:profile opts) "-" (:index %))) nodes))))

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
     [(raw-spec (str dir "/files/colors-compute-endpoint") (:content (endpoint/endpoint-agent (:provider-compute opts))))
      (raw-spec (str dir "/inventory.json") (inventory opts))])))

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
