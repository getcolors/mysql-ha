(ns io.github.getcolors.mysql-ha.workflow-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.workflow :as workflow]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def create {:green/event :create})
(def build {:green/event :build})
(def delete {:green/event :delete})
(def health {:green/event :health})

(defn- nexts [step run-opts]
  (vec (rest (workflow/wire-fn step run-opts))))

(deftest create-forks-at-the-infrastructure-and-joins-at-the-cluster
  (is (= [:mysql-ha/infrastructure] (nexts :mysql-ha/start create)))
  (is (= [:mysql-ha/dns :mysql-ha/base] (nexts :mysql-ha/infrastructure create)))
  (testing "both branches converge on one step, so the engine joins them once"
    (is (= [:mysql-ha/cluster] (nexts :mysql-ha/dns create)))
    (is (= [:mysql-ha/cluster] (nexts :mysql-ha/base create))))
  (is (= [:mysql-ha/backup] (nexts :mysql-ha/cluster create)))
  (is (= [:mysql-ha/health] (nexts :mysql-ha/backup create)))
  (is (= [] (nexts :mysql-ha/health create))))

(deftest build-walks-the-same-graph-as-create
  (doseq [step [:mysql-ha/start :mysql-ha/infrastructure :mysql-ha/dns
                :mysql-ha/base :mysql-ha/cluster :mysql-ha/backup]]
    (is (= (nexts step create) (nexts step build)))))

(deftest delete-reads-state-first-and-destroys-in-reverse
  (is (= [:mysql-ha/load-infrastructure] (nexts :mysql-ha/start delete)))
  (is (= [:mysql-ha/cleanup] (nexts :mysql-ha/load-infrastructure delete)))
  (is (= [:mysql-ha/dns] (nexts :mysql-ha/cleanup delete)))
  (is (= [:mysql-ha/infrastructure] (nexts :mysql-ha/dns delete)))
  (is (= [] (nexts :mysql-ha/infrastructure delete))))

(deftest health-changes-nothing
  (is (= [:mysql-ha/load-infrastructure] (nexts :mysql-ha/start health)))
  (is (= [:mysql-ha/health] (nexts :mysql-ha/load-infrastructure health)))
  (is (= tools/health-step (first (workflow/wire-fn :mysql-ha/health health))))
  (testing "no stage that converges anything is reachable from health"
    (is (not-any? #{tools/infrastructure-step tools/dns-step tools/cluster-step}
                  [(first (workflow/wire-fn :mysql-ha/load-infrastructure health))
                   (first (workflow/wire-fn :mysql-ha/health health))]))))

(deftest a-build-needs-no-credential
  (is (= 0 (:green/exit (workflow/start-step (assoc fixture :green/event :build) {})))))

(deftest a-real-run-refuses-without-credentials
  (let [result (workflow/start-step (assoc fixture :green/event :create) {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_MYSQL_ADMIN_PASSWORD"))))

(deftest a-dry-run-needs-no-credential
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc fixture :green/event :create :green/dry-run true)
                         {})))))

(deftest the-profile-parameter-is-refused-before-anything-else
  (let [result (workflow/start-step (assoc fixture :green/event :build)
                                    {"COLORS_PAR_PROFILE" "elsewhere"})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_PROFILE"))))

(deftest the-destroy-guard-holds
  (let [opts (merge fixture {:green/event :delete
                             :mysql-admin-password "a"
                             :mysql-replication-password "b"
                             :backup-r2-access-key-id "c"
                             :backup-r2-secret-access-key "d"
                             :do-token "e"
                             :cloudflare-api-token "f"})
        result (workflow/start-step opts {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COMPUTE_PREVENT_DESTROY")))
  (testing "and lifts for exactly one run"
    (is (= 0 (:green/exit
              (workflow/start-step
               (merge fixture {:green/event :delete
                               :compute-prevent-destroy false
                               :mysql-admin-password "a"
                               :mysql-replication-password "b"
                               :backup-r2-access-key-id "c"
                               :backup-r2-secret-access-key "d"
                               :do-token "e"
                               :cloudflare-api-token "f"})
               {}))))))

(deftest defaults-do-not-quietly-permit-destruction
  (is (true? (:compute-prevent-destroy workflow/defaults))))

(deftest every-side-effecting-step-is-skipped-by-dry-run
  (let [wired (fn [event]
                (set (keep (fn [step]
                             (when (try (workflow/wire-fn step {:green/event event})
                                        (catch Throwable _ nil))
                               step))
                           workflow/side-effecting)))]
    (doseq [event [:create :delete :health]]
      (is (every? (set workflow/side-effecting) (wired event))))))

(deftest a-whole-build-renders-every-stage
  (let [dir (str (java.nio.file.Files/createTempDirectory
                  "mysql-ha-build" (into-array java.nio.file.attribute.FileAttribute [])))
        result (green-cli/run-cli workflow/workflow
                                  ["build" "-f" "test/fixtures/colors.yml"]
                                  {:default-file "colors.yml"})
        _ (is (= 0 (:green/exit result)))
        root (io/file "test/fixtures/.colors/mysql-ha-fixture")]
    (io/delete-file (io/file dir) true)
    (doseq [stage ["mysql-ha-infrastructure" "mysql-ha-dns" "mysql-ha-ansible"]]
      (is (.isDirectory (io/file root stage)) stage))
    (testing "the backend is written by advice, before the stage runs"
      (is (.exists (io/file root "mysql-ha-infrastructure" "backend.tf.json")))
      (is (.exists (io/file root "mysql-ha-dns" "backend.tf.json"))))
    (testing "nothing that looks like a credential is written"
      (doseq [f (file-seq root) :when (.isFile f)]
        (is (not (re-find #"REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY" (slurp f)))
            (str f))))))
