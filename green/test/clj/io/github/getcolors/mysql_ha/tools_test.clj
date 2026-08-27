(ns io.github.getcolors.mysql-ha.tools-test
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.utils :as utils]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(deftest the-topology-is-a-pure-function-of-desired-state
  (is (= (tools/nodes fixture) (tools/nodes fixture)))
  (is (= ["fixture-node-1" "fixture-node-2" "fixture-node-3"]
         (mapv :name (tools/nodes fixture))))
  (is (= [101 102 103] (mapv :server-id (tools/nodes fixture))))
  (testing "the archiver's pseudo-replica ids cannot collide with a member's"
    (is (empty? (clojure.set/intersection
                 (set (map :server-id (tools/nodes fixture)))
                 (set (map :connection-server-id (tools/nodes fixture))))))))

(deftest every-member-seeds-from-every-member
  (let [seeds (tools/group-seeds (merge tools/fallback-outputs fixture))]
    (is (= 3 (count (str/split seeds #","))))
    (is (str/includes? seeds ":33061"))))

(deftest the-inventory-names-both-groups
  (let [inv (json/parse-string (tools/inventory fixture) true)
        children (get-in inv [:all :children])]
    (is (= 3 (count (get-in children [:mysql :hosts]))))
    (is (= ["fixture-node-1"] (map name (keys (get-in children [:bootstrap :hosts])))))
    (testing "bootstrap is only ever member one, and only for an empty group"
      (is (= (get-in children [:mysql :hosts :fixture-node-1])
             (get-in children [:bootstrap :hosts :fixture-node-1]))))
    (is (= "~/.ssh/id_ed25519"
           (get-in children [:mysql :hosts :fixture-node-2
                             :ansible_ssh_private_key_file])))))

(deftest the-inventory-is-byte-stable
  (is (= (tools/inventory fixture) (tools/inventory fixture))))

(deftest build-never-reads-state
  (testing "fallback addresses are documentation range, so a leak fails loudly"
    (is (every? #(str/starts-with? % "192.0.2.")
                (:node_public_ips tools/fallback-outputs)))
    (is (str/starts-with? (:reserved_ip tools/fallback-outputs) "192.0.2."))))

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

(deftest the-backup-prefix-never-carries-a-trailing-slash
  (is (= "mysql-ha-fixture" (utils/backup-prefix fixture)))
  (is (= "a/b" (utils/backup-prefix {:backup-r2-prefix "a/b//"}))))
