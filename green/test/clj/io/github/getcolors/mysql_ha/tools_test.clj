(ns io.github.getcolors.mysql-ha.tools-test
  (:require [clojure.test :refer [deftest is testing]] [clojure.string :as str] [cheshire.core :as json]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.utils :as utils]
            [io.github.getcolors.mysql-ha.validate-test :refer [base]]))
(def fixture base)
(def recorded {:nodes (mapv (fn [i] {:node_id (str i) :index i :role nil :provider "digitalocean"
  :name (str "db" i) :ip (str "203.0.113." (+ 11 i)) :vpc_ip (str "10.20.0." (+ 11 i))
  :provider_id (str (+ 100 i)) :user "ubuntu" :sudoer "ubuntu"}) (range 3))})
(def observed (assoc base :green/event :create :colors-compute/cluster recorded
                         :colors-compute/shared {:params {:network_cidr "10.20.0.0/20" :endpoint_ip "203.0.113.8"}}
                         :ssh-private-key-path "/tmp/owned"))
(deftest observed-identities-network-and-endpoint-feed-application
  (let [members (tools/nodes observed) data (tools/data-fn observed)
        hosts (get-in (json/parse-string (tools/inventory observed) true) [:all :children :mysql :hosts])]
    (is (= [101 102 103] (mapv :server-id members)))
    (is (empty? (clojure.set/intersection (set (map :server-id members)) (set (map :connection-server-id members)))))
    (is (= ["100" "101" "102"] (mapv :uid members)))
    (is (= "ubuntu" (:ansible_user (:db0 hosts))))
    (is (= "100" (:node_uid (:db0 hosts))))
    (is (= "10.20.0.0/20" (:vpc_ip_range data)))
    (is (= "203.0.113.8" (:reserved_ip data)))
    (is (= "10.20.0.11:33061,10.20.0.12:33061,10.20.0.13:33061" (:group-seeds data)))))
(deftest real-run-refuses-missing-shared-and-node-identities
  (is (thrown? Exception (tools/data-fn (dissoc observed :colors-compute/shared))))
  (is (thrown? Exception (tools/nodes (update-in observed [:colors-compute/cluster :nodes] #(mapv (fn [n] (dissoc n :provider_id)) %))))))
(deftest library-endpoint-artifact-is-rendered-without-secrets
  (let [specs (tools/ansible-specs fixture)]
    (is (some #(str/ends-with? (:target %) "/files/colors-compute-endpoint") specs))
    (is (= (:endpoint-credentials (tools/data-fn fixture)) ["COLORS_PAR_DO_TOKEN"]))))
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


(deftest the-backup-prefix-never-carries-a-trailing-slash
  (is (= "mysql-ha-fixture" (utils/backup-prefix fixture)))
  (is (= "a/b" (utils/backup-prefix {:backup-r2-prefix "a/b//"}))))
