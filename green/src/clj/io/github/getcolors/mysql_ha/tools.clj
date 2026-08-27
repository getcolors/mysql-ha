(ns io.github.getcolors.mysql-ha.tools
  "OpenTofu and Ansible stages for the three-member Group Replication cluster.

  Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
  reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
  One Ansible directory holds every playbook, because they share an inventory
  and a set of rendered scripts and splitting them across directories would
  duplicate both."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.mysql-ha.utils :as utils]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def infrastructure-tool "mysql-ha-infrastructure")
(def dns-tool "mysql-ha-dns")
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

;; ---------------------------------------------------------------------------
;; infrastructure

(def fallback-outputs
  "Stand-ins so `build` and `--dry-run` render the same shape of file as a real
  run, without ever reading state or contacting a provider. Documentation-range
  addresses, so a rendered artifact that leaked into a real run would fail
  loudly rather than reach something."
  {:node_public_ips ["192.0.2.11" "192.0.2.12" "192.0.2.13"]
   :node_private_ips ["10.110.0.11" "10.110.0.12" "10.110.0.13"]
   :node_droplet_ids [100000001 100000002 100000003]
   :reserved_ip "192.0.2.10"
   :vpc_id "00000000-0000-0000-0000-000000000000"
   :vpc_ip_range "10.110.0.0/20"})

(defn infrastructure-specs [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        data (assoc opts
                    :node-count (utils/node-count opts)
                    :digitalocean-ssh-sources-json
                    (json/generate-string (:digitalocean-ssh-sources opts))
                    :digitalocean-client-sources-json
                    (json/generate-string (:digitalocean-client-sources opts)))]
    [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)]))

(defn- outputs-map [result]
  (some-> (:mysql-ha/outputs result) walk/keywordize-keys))

(defn infrastructure-step [opts]
  (let [result (tofu/tofu-with-spec
                opts (infrastructure-specs opts)
                {:dir (tool-dir opts infrastructure-tool)
                 :env (credential-env opts :provider-compute)
                 :output-key :mysql-ha/outputs})]
    (cond
      (wf/failed? result) result
      (= :delete (:green/event opts)) result
      (= :build (:green/event opts)) (merge result fallback-outputs)
      :else (merge result fallback-outputs (outputs-map result)))))

(defn process-result [opts label {:keys [exit out err]}]
  (if (zero? exit)
    (assoc opts :green/exit 0)
    (assoc opts :green/exit (max 1 exit)
                :green/err (str label " failed: "
                                (or (not-empty err) (not-empty out) "(no output)")))))

(defn load-infrastructure-step
  "Read node addresses out of remote state without planning or changing
  anything. Delete and health both need the inventory and neither can
  re-derive it; `k8s` needs the same thing for the same reason."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        rendered (assoc (sc/scaffold (assoc opts :green/event :build)
                                     (infrastructure-specs opts))
                        :green/event (:green/event opts))
        env (merge (into {} (System/getenv))
                   (credential-env opts :provider-compute))
        init (process/run ["tofu" (str "-chdir=" dir) "init" "-input=false" "-no-color"]
                          {:extra-env env})]
    (if-not (zero? (:exit init))
      (process-result rendered "infrastructure state initialization" init)
      (try
        (let [outputs (tofu/outputs dir env)]
          (merge rendered fallback-outputs outputs
                 {:mysql-ha/infrastructure-present? (contains? outputs :reserved_ip)}))
        (catch Throwable t
          (assoc rendered :green/exit 1
                          :green/err (str "infrastructure state output failed: "
                                          (or (ex-message t) (str (class t))))))))))

;; ---------------------------------------------------------------------------
;; shared template data

(defn nodes
  "One map per member, in ordinal order, merging desired state with whatever
  the infrastructure stage reported. Pure: given the same opts it is the same
  vector, which is what makes the inventory and the goldens deterministic."
  [opts]
  (let [data (merge fallback-outputs opts)]
    (mapv (fn [ordinal]
            (let [idx (dec ordinal)]
              {:ordinal ordinal
               :name (utils/node-name opts ordinal)
               :host (utils/node-host opts ordinal)
               :public-ip (nth (:node_public_ips data) idx nil)
               :private-ip (nth (:node_private_ips data) idx nil)
               :droplet-id (nth (:node_droplet_ids data) idx nil)
               :server-id (utils/server-id ordinal)
               :connection-server-id (utils/connection-server-id ordinal)}))
          (utils/ordinals opts))))

(defn group-seeds
  "`group_replication_group_seeds`: every member's private address on the group
  port. Every member gets the same list, so a joining member can reach the
  group through whichever seed is up."
  [opts]
  (str/join "," (map #(str (:private-ip %) ":" (:mysql-group-port opts))
                     (nodes opts))))

(defn data-fn [opts]
  (let [data (merge fallback-outputs opts)]
    (assoc data
           :node-count (utils/node-count opts)
           :backup-prefix (utils/backup-prefix opts)
           :group-seeds (group-seeds data)
           :cluster-record (utils/record-name (:cluster-host opts)))))

(defn inventory
  "Ansible inventory as JSON. Every member is in `mysql`; `primary_candidate`
  names member one, which is only ever used to pick who bootstraps an empty
  group — it carries no meaning once the group exists."
  [opts]
  (let [data (data-fn opts)
        key-file (str (:digitalocean-ssh-private-key data))
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
                    (nodes data))]
    (json/generate-string
     {:all {:children
            {:mysql {:hosts hosts}
             :bootstrap {:hosts (select-keys hosts [(utils/node-name opts 1)])}}}}
     {:pretty true})))

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
