(ns io.github.getcolors.mysql-ha.tools-test
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [clojure.walk :as walk]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.utils :as utils]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "optout.yml" (slurp "test/fixtures/optout.yml")))

(def legacy-outputs
  "A pre-adoption state exactly as `tofu output -json` parsed it: the six
  outputs, three parallel lists among them, and no `params`."
  {:node_public_ips ["203.0.113.11" "203.0.113.12" "203.0.113.13"]
   :node_private_ips ["10.110.0.5" "10.110.0.6" "10.110.0.7"]
   :node_droplet_ids [512000001 512000002 512000003]
   :reserved_ip "203.0.113.10"
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.110.0.0/20"})

(def recorded
  "`params` as the adopted template records it, here through the legacy
  translation so the two shapes are provably one."
  (tools/legacy-params fixture legacy-outputs "x"))

(deftest the-topology-is-a-pure-function-of-desired-state
  (is (= (tools/nodes fixture) (tools/nodes fixture)))
  (is (= ["fixture-node-1" "fixture-node-2" "fixture-node-3"]
         (mapv :name (tools/nodes fixture))))
  (is (= [101 102 103] (mapv :server-id (tools/nodes fixture))))
  (testing "the archiver's pseudo-replica ids cannot collide with a member's"
    (is (empty? (clojure.set/intersection
                 (set (map :server-id (tools/nodes fixture)))
                 (set (map :connection-server-id (tools/nodes fixture))))))))

(deftest build-never-reads-state
  ;; ONCE's fallbacks at offset 11 are the addresses this package always
  ;; rendered; documentation range, so a leak fails loudly.
  (is (= ["192.0.2.11" "192.0.2.12" "192.0.2.13"] (mapv :public-ip (tools/nodes fixture))))
  (is (= ["10.110.0.11" "10.110.0.12" "10.110.0.13"] (mapv :private-ip (tools/nodes fixture))))
  (is (= [100000001 100000002 100000003] (mapv :droplet-id (tools/nodes fixture))))
  (is (str/starts-with? (:reserved_ip tools/fallback-outputs) "192.0.2."))
  (is (= (:reserved_ip tools/fallback-outputs) (:reserved_ip (tools/data-fn fixture)))))

(deftest a-real-run-reads-every-node-from-the-adopted-cluster
  (let [opts (assoc fixture :once/cluster recorded)
        members (tools/nodes opts)]
    (is (= ["203.0.113.11" "203.0.113.12" "203.0.113.13"] (mapv :public-ip members)))
    (is (= ["10.110.0.5" "10.110.0.6" "10.110.0.7"] (mapv :private-ip members)))
    (is (= [512000001 512000002 512000003] (mapv :droplet-id members)))
    (is (= ["fixture-node-1" "fixture-node-2" "fixture-node-3"] (mapv :name members)))
    (testing "the cluster facts beside the nodes come from state too"
      (is (= "203.0.113.10" (:reserved_ip (tools/data-fn opts))))
      (is (= "5a6b7c8d-0000-4000-8000-000000000001" (:vpc_id (tools/data-fn opts))))
      (is (= "10.110.0.5:33061,10.110.0.6:33061,10.110.0.7:33061" (tools/group-seeds opts))))
    (testing "and reach the inventory and the DNS records"
      (is (= "203.0.113.12"
             (get-in (json/parse-string (tools/inventory opts) true)
                     [:all :children :mysql :hosts :fixture-node-2 :ansible_host])))
      (is (= "203.0.113.13"
             (get (json/parse-string (:node-records-json (:data (first (tools/dns-specs opts)))))
                  "node-3.my-ha.fixture.example"))))))

(deftest the-legacy-state-is-translated-into-params
  (is (= "digitalocean" (:provider recorded)))
  (is (= [0 1 2] (mapv :index (:nodes recorded))))
  (is (every? nil? (map :role (:nodes recorded))))
  (is (= ["fixture-node-1" "fixture-node-2" "fixture-node-3"] (mapv :name (:nodes recorded))))
  (is (= {:ip "203.0.113.12" :vpc_ip "10.110.0.6" :droplet_id 512000002 :user "root" :sudoer "root"}
         (select-keys (second (:nodes recorded)) [:ip :vpc_ip :droplet_id :user :sudoer])))
  (is (= ["203.0.113.10" "5a6b7c8d-0000-4000-8000-000000000001" "10.110.0.0/20"]
         (map recorded [:reserved_ip :vpc_id :vpc_ip_range])))
  (is (empty? (cluster/node-errors validate/spec fixture recorded))
      "ONCE accepts the translation as a whole cluster")
  (is (= [] (tools/params-errors recorded))))

(deftest the-legacy-translation-refuses-to-guess
  (let [refusal (fn [outputs]
                  (try (tools/legacy-params fixture outputs "stage-dir") nil
                       (catch clojure.lang.ExceptionInfo e e)))]
    (testing "lists that disagree with each other"
      (let [e (refusal (assoc legacy-outputs :node_public_ips ["203.0.113.11" "203.0.113.12"]))]
        (is (= "legacy state lists 2 public addresses, 3 private addresses and 3 droplet ids; refusing to guess the cluster"
               (ex-message e)))
        (is (= "stage-dir" (:dir (ex-data e))) "the SDK's step-error shape, so read-state reports it")))
    (testing "lists that disagree with cluster-nodes"
      (let [four (fn [v] (conj v (last v)))
            e (refusal (-> legacy-outputs
                           (update :node_public_ips four)
                           (update :node_private_ips four)
                           (update :node_droplet_ids four)))]
        (is (= "legacy state lists 4 public addresses, 4 private addresses and 4 droplet ids; refusing to guess the cluster"
               (ex-message e)))))
    (testing "no reserved ip"
      (is (= "legacy state carries no reserved_ip"
             (ex-message (refusal (dissoc legacy-outputs :reserved_ip)))))
      (is (= "legacy state carries no reserved_ip"
             (ex-message (refusal (assoc legacy-outputs :reserved_ip ""))))))
    (testing "the other extension keys are params-errors' to refuse, the same as a recorded state"
      (is (= ["compute state carries no vpc_id"]
             (tools/params-errors (tools/legacy-params fixture (dissoc legacy-outputs :vpc_id) "x")))))))

(deftest params-errors-hold-the-extension-keys
  (is (= [] (tools/params-errors recorded)))
  (is (= ["compute state carries no reserved_ip"] (tools/params-errors (assoc recorded :reserved_ip " "))))
  (is (= ["compute state carries no vpc_id"] (tools/params-errors (dissoc recorded :vpc_id))))
  (is (= ["compute state carries no vpc_ip_range"] (tools/params-errors (assoc recorded :vpc_ip_range nil))))
  (is (= ["compute state vpc_ip_range \"10.110.0.1/20\" is not a canonical IPv4 network such as 10.40.0.0/24"]
         (tools/params-errors (assoc recorded :vpc_ip_range "10.110.0.1/20"))))
  (is (= ["compute state carries no droplet_id for 1, 2"]
         (tools/params-errors (update recorded :nodes
                                      (fn [ns] [(first ns) (dissoc (second ns) :droplet_id)
                                                (assoc (nth ns 2) :droplet_id "")]))))))

(deftest load-infrastructure-adopts-the-state-preflight-handed-on
  (let [load (fn [event state]
               (tools/load-infrastructure-step
                (assoc fixture :green/event event :mysql-ha/state state)))]
    (testing "a recorded cluster"
      (let [r (load :delete {:params recorded})]
        (is (= 0 (:green/exit r)))
        (is (= recorded (:once/cluster r)))
        (is (true? (:mysql-ha/infrastructure-present? r)))
        (is (not (contains? r :mysql-ha/state)))
        (is (= ["203.0.113.11" "203.0.113.12" "203.0.113.13"] (mapv :public-ip (tools/nodes r))))))
    (testing "a readable state that records no cluster"
      (let [r (load :delete {:params nil})]
        (is (= 0 (:green/exit r)))
        (is (false? (:mysql-ha/infrastructure-present? r)))
        (is (not (contains? r :once/cluster)))
        (is (= 0 (:green/exit (tools/cleanup-step r))) "the cleanup has nothing to reach and skips itself"))
      (let [r (load :health {:params nil})]
        (is (= 1 (:green/exit r)))
        (is (= tools/no-cluster-message (:green/err r)))))
    (testing "an unreadable backend fails closed"
      (let [r (load :delete {:error "tofu output failed: no backend"})]
        (is (= 1 (:green/exit r)))
        (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
        (is (str/includes? (:green/err r) "no backend")))
      (is (str/includes? (:green/err (load :health {:error "x"}))
                         "could not read the infrastructure state for health")))
    (testing "a partial cluster is refused with ONCE's message"
      (let [r (load :delete {:params (update recorded :nodes #(vec (take 2 %)))})]
        (is (= 1 (:green/exit r)))
        (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r)))))
    (testing "an adopted cluster without its extension keys is refused"
      (let [r (load :delete {:params (dissoc recorded :vpc_id)})]
        (is (= 1 (:green/exit r)))
        (is (= "compute state carries no vpc_id" (:green/err r)))))))

(deftest a-real-create-resolves-the-cluster-from-the-apply
  ;; The apply's `params` output, string-keyed as `tofu output -json` parses
  ;; it, is what every later stage reads; never the fallbacks.
  (let [opts (assoc fixture :green/event :create)
        apply (fn [params]
                (tools/resolve-infrastructure
                 opts (cond-> (assoc opts :green/exit 0)
                        params (assoc :mysql-ha/outputs {:params (walk/stringify-keys params)}))))]
    (let [r (apply recorded)]
      (is (= 0 (:green/exit r)))
      (is (= recorded (:once/cluster r)))
      (is (= ["203.0.113.11" "203.0.113.12" "203.0.113.13"] (mapv :public-ip (tools/nodes r)))))
    (let [r (apply nil)]
      (is (= 1 (:green/exit r)))
      (is (= cluster/no-params-message (:green/err r))))
    (let [r (apply (update recorded :nodes #(vec (take 2 %))))]
      (is (= 1 (:green/exit r)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err r))))
    (let [r (apply (update recorded :nodes (fn [ns] (mapv #(dissoc % :droplet_id) ns))))]
      (is (= 1 (:green/exit r)))
      (is (= "compute state carries no droplet_id for 0, 1, 2" (:green/err r))))
    (testing "a failed apply, a delete and a build hand the result on untouched"
      (is (= 1 (:green/exit (tools/resolve-infrastructure opts (assoc opts :green/exit 1 :green/err "apply failed")))))
      (is (not (contains? (tools/resolve-infrastructure (assoc opts :green/event :build) (assoc opts :green/exit 0)) :once/cluster)))
      (is (= 0 (:green/exit (tools/resolve-infrastructure (assoc opts :green/event :delete) (assoc opts :green/exit 0))))))))

(deftest the-inventory-names-both-groups
  (let [inv (json/parse-string (tools/inventory fixture) true)
        children (get-in inv [:all :children])]
    (is (= 3 (count (get-in children [:mysql :hosts]))))
    (is (= ["fixture-node-1"] (map name (keys (get-in children [:bootstrap :hosts])))))
    (testing "bootstrap is only ever member one, and only for an empty group"
      (is (= (get-in children [:mysql :hosts :fixture-node-1])
             (get-in children [:bootstrap :hosts :fixture-node-1]))))
    (testing "the members are reached with the generated key in keygen mode, on a build through the placeholder"
      (is (= "/home/build-placeholder/.ssh/mysql-ha-fixture"
             (get-in (json/parse-string (tools/inventory (assoc fixture :green/event :build)) true)
                     [:all :children :mysql :hosts :fixture-node-2 :ansible_ssh_private_key_file]))))
    (testing "and with the operator's own key in opt-out mode"
      (is (= "~/.ssh/id_ed25519"
             (get-in (json/parse-string (tools/inventory optout) true)
                     [:all :children :mysql :hosts :fixture-node-2 :ansible_ssh_private_key_file]))))))

(deftest the-local-stage-writes-one-block-per-alias-and-carries-no-address
  (let [data (:data (first (tools/ansible-local-specs fixture)))]
    (is (true? (:ssh-keygen data)))
    (is (= "~/.ssh/mysql-ha-fixture" (:ssh-config-identity-file data)))
    (is (= "mysql-ha-fixture" (:host-alias data)))
    (is (not (contains? data :ssh_hosts)) "addresses travel as extra-vars, never through Selmer"))
  (is (false? (:ssh-keygen (:data (first (tools/ansible-local-specs optout))))))
  (testing "the bare alias points at member one, then one alias per member"
    (is (= [{:name "mysql-ha-fixture" :ip "192.0.2.11"}
            {:name "mysql-ha-fixture-0" :ip "192.0.2.11"}
            {:name "mysql-ha-fixture-1" :ip "192.0.2.12"}
            {:name "mysql-ha-fixture-2" :ip "192.0.2.13"}]
           (tools/ssh-config-hosts fixture))))
  (testing "a delete whose state records no cluster has no block to withdraw"
    (is (= 0 (:green/exit (tools/ansible-local-step
                           (assoc fixture :green/event :delete
                                  :mysql-ha/infrastructure-present? false)))))))

(deftest the-inventory-is-byte-stable
  (is (= (tools/inventory fixture) (tools/inventory fixture))))

(deftest stage-directories-are-remote-state-keys
  (doseq [tool tools/tofu-tools]
    (is (str/ends-with? (tools/tool-dir fixture tool) (str "/" tool))))
  (is (= ["mysql-ha-infrastructure" "mysql-ha-dns"] tools/tofu-tools)))

(deftest the-rendered-tree-is-exactly-what-a-member-needs
  (let [targets (map :target (tools/ansible-specs fixture))
        names (map #(last (str/split % #"/")) targets)]
    (is (every? (set names)
                ["ansible.cfg" "base.yml" "cluster.yml" "backup.yml"
                 "health.yml" "cleanup.yml" "inventory.json"
                 "mysqld.cnf" "verify.cnf" "apparmor-local" "node.env"
                 "mysql-ha-lib" "mysql-ha-endpoint" "mysql-ha-heartbeat"
                 "mysql-ha-snapshot" "mysql-ha-binlog-archive"
                 "mysql-ha-binlog-upload" "mysql-ha-restore-check"
                 "mysql-ha-health"]))
    (testing "no file holding a credential is ever rendered"
      (is (not-any? (set names) ["rclone.conf" "secrets.env" "binlog-client.cnf"])))))

(deftest the-dns-stage-points-at-the-reserved-ip-and-the-members
  (let [data (:data (first (tools/dns-specs fixture)))
        records (json/parse-string (:node-records-json data))]
    (is (= (:reserved_ip tools/fallback-outputs) (:reserved_ip data)))
    (is (= ["node-1.my-ha.fixture.example"
            "node-2.my-ha.fixture.example"
            "node-3.my-ha.fixture.example"]
           (vec (keys records))))))

(deftest the-source-lists-reach-the-template-as-json-lists
  (let [data (:data (first (tools/infrastructure-specs fixture)))]
    (is (= "[\"203.0.113.7/32\"]" (:digitalocean-ssh-sources-json data)))
    (testing "an overlay string renders the same list"
      (is (= "[\"203.0.113.7/32\",\"198.51.100.0/24\"]"
             (:digitalocean-client-sources-json
              (:data (first (tools/infrastructure-specs
                             (assoc fixture :digitalocean-client-sources
                                    "203.0.113.7/32, 198.51.100.0/24"))))))))))

(deftest the-backup-prefix-never-carries-a-trailing-slash
  (is (= "mysql-ha-fixture" (utils/backup-prefix fixture)))
  (is (= "a/b" (utils/backup-prefix {:backup-r2-prefix "a/b//"}))))
