(ns io.github.getcolors.mysql-ha.workflow-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.java.io :as io]
            [green.workflow :as wf]
            [io.github.getcolors.compute-orchestration :as compute]
            [io.github.getcolors.compute-inspection :as inspection]
            [io.github.getcolors.mysql-ha.workflow :as workflow]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.compute :as cluster]
            [io.github.getcolors.mysql-ha.ssh-config :as config]
            [io.github.getcolors.mysql-ha.validate :as validate]
            [io.github.getcolors.mysql-ha.validate-test :refer [base]]
            [io.github.getcolors.mysql-ha.tools-test :refer [recorded]]))
(def params recorded)
(deftest adapter-delegates-compute-and-retains-shared-network
  (with-redefs [compute/orchestrate (fn [& _] {:status "ready" :cluster params :shared {:params {:network_cidr "10.20.0.0/20"}} :key {:private_key_path "/tmp/owned"}})]
    (let [result (tools/infrastructure-step (assoc base :green/event :create))]
      (is (= params (:colors-compute/cluster result)))
      (is (= "10.20.0.0/20" (get-in result [:colors-compute/shared :params :network_cidr])))
      (is (= "/tmp/owned" (:ssh-private-key-path result))))))
(deftest deletion-loads-only-owned-inventory-and-protection-precedes-inspection
  (with-redefs [inspection/read-deployment (fn [& _] {:status "present" :cluster params :shared {:params {:network_cidr "10.20.0.0/20"}}})]
    (is (= params (:colors-compute/cluster (tools/load-infrastructure-step (assoc base :green/event :delete))))))
  (with-redefs [inspection/read-deployment (fn [& _] {:status "error"})]
    (is (= 1 (:green/exit (tools/load-infrastructure-step (assoc base :green/event :delete)))))))
(deftest full-native-build-is-credential-free
  (let [directory (.toFile (java.nio.file.Files/createTempDirectory "mysql-green-build-" (make-array java.nio.file.attribute.FileAttribute 0)))]
    (try
      (with-redefs [compute/orchestrate (fn [& _] (throw (AssertionError. "build must not compute")))
                    inspection/read-deployment (fn [& _] (throw (AssertionError. "build must not inspect")))]
        (let [result (wf/run workflow/workflow (assoc base :green/event :build :workdir (.getPath directory)))
              names (set (map #(.getName %) (file-seq directory)))]
          (is (= 0 (:green/exit result)) (:green/err result))
          (is (contains? names "node.tf.json"))
          (is (contains? names "shared.tf.json"))
          (is (contains? names "inventory.json"))))
      (finally (doseq [file (reverse (file-seq directory))] (io/delete-file file))))))

(def create {:green/event :create})
(def build {:green/event :build})
(def delete {:green/event :delete})
(def health {:green/event :health})
(defn- nexts [step opts] (vec (rest (workflow/wire-fn step opts))))
(deftest create-forks-after-the-local-ssh-config-and-joins-at-the-cluster
  (is (= [:mysql-ha/infrastructure] (nexts :mysql-ha/start create)))
  (testing "the block is written after compute, where the addresses first exist, and before any member is converged"
    (is (= [:mysql-ha/ansible-local] (nexts :mysql-ha/infrastructure create)))
    (is (= tools/ansible-local-step (first (workflow/wire-fn :mysql-ha/ansible-local create)))))
  (is (= [:mysql-ha/dns :mysql-ha/base] (nexts :mysql-ha/ansible-local create)))
  (testing "both branches converge on one step, so the engine joins them once"
    (is (= [:mysql-ha/cluster] (nexts :mysql-ha/dns create)))
    (is (= [:mysql-ha/cluster] (nexts :mysql-ha/base create))))
  (is (= [:mysql-ha/backup] (nexts :mysql-ha/cluster create)))
  (is (= [:mysql-ha/health] (nexts :mysql-ha/backup create)))
  (is (= [] (nexts :mysql-ha/health create))))

(deftest build-walks-the-same-graph-as-create
  (doseq [step [:mysql-ha/start :mysql-ha/infrastructure :mysql-ha/ansible-local
                :mysql-ha/dns :mysql-ha/base :mysql-ha/cluster :mysql-ha/backup]]
    (is (= (nexts step create) (nexts step build)))))

(deftest health-changes-nothing
  (is (= [:mysql-ha/load-infrastructure] (nexts :mysql-ha/start health)))
  (is (= [:mysql-ha/health] (nexts :mysql-ha/load-infrastructure health)))
  (is (= tools/health-step (first (workflow/wire-fn :mysql-ha/health health))))
  (testing "no stage that converges anything is reachable from health"
    (is (not-any? #{tools/infrastructure-step tools/dns-step tools/cluster-step}
                  [(first (workflow/wire-fn :mysql-ha/load-infrastructure health))
                   (first (workflow/wire-fn :mysql-ha/health health))]))))

(deftest delete-cleans-application-before-library-destroy
  (is (= [:mysql-ha/load-infrastructure] (nexts :mysql-ha/start delete)))
  (is (= [:mysql-ha/cleanup] (nexts :mysql-ha/load-infrastructure delete)))
  (is (= [:mysql-ha/ansible-local] (nexts :mysql-ha/cleanup delete)))
  (is (= [:mysql-ha/dns] (nexts :mysql-ha/ansible-local delete)))
  (is (= [:mysql-ha/infrastructure] (nexts :mysql-ha/dns delete)))
  (is (= [] (nexts :mysql-ha/infrastructure delete))))
(deftest health-refuses-destroyed-deployment
  (with-redefs [inspection/read-deployment (fn [& _] {:status "destroyed"})]
    (is (= 1 (:green/exit (tools/load-infrastructure-step (assoc base :green/event :health)))))))
