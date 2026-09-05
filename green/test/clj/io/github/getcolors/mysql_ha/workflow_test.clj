(ns io.github.getcolors.mysql-ha.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.mysql-ha.ssh :as ssh]
            [io.github.getcolors.mysql-ha.tools :as tools]
            [io.github.getcolors.mysql-ha.workflow :as workflow]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "optout.yml" (slurp "test/fixtures/optout.yml")))

(def create {:green/event :create})
(def build {:green/event :build})
(def delete {:green/event :delete})
(def health {:green/event :health})

(def credentials
  {:mysql-admin-password "a"
   :mysql-replication-password "b"
   :backup-r2-access-key-id "c"
   :backup-r2-secret-access-key "d"
   :do-token "e"
   :cloudflare-api-token "f"})

(def recorded
  "`params` as a converged deployment records it."
  {:provider "digitalocean"
   :reserved_ip "203.0.113.10"
   :vpc_id "5a6b7c8d-0000-4000-8000-000000000001"
   :vpc_ip_range "10.110.0.0/20"
   :nodes (mapv (fn [i] {:index i :role nil :name (str "fixture-node-" (inc i))
                         :ip (str "203.0.113.1" (inc i)) :vpc_ip (str "10.110.0." (+ 5 i))
                         :droplet_id (+ 512000001 i) :user "root" :sudoer "root"})
                (range 3))})

;; The compute state is read once per run, through the reader, on a real
;; create, delete or health. Every lifecycle test injects one: nil is a
;; readable state holding no compute, a map is a recorded `params`, and a
;; throw is a backend that cannot be read.
(defn- start [opts state]
  (workflow/start-step opts {} (fn [_] state)))

(defn- start-unreadable [opts]
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  (workflow/start-step opts {} (fn [_] (throw (ex-info "tofu output failed: no backend" {:dir "x"})))))

(defn- nexts [step run-opts]
  (vec (rest (workflow/wire-fn step run-opts))))

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

(deftest delete-reads-state-first-and-destroys-in-reverse
  (is (= [:mysql-ha/load-infrastructure] (nexts :mysql-ha/start delete)))
  (is (= [:mysql-ha/cleanup] (nexts :mysql-ha/load-infrastructure delete)))
  (testing "the ssh config block goes before the destroy, the keypair after it (ssh-config.md §4)"
    (is (= [:mysql-ha/ansible-local] (nexts :mysql-ha/cleanup delete)))
    (is (= [:mysql-ha/dns] (nexts :mysql-ha/ansible-local delete)))
    (is (= [:mysql-ha/infrastructure] (nexts :mysql-ha/dns delete)))
    (is (= [:mysql-ha/ssh-cleanup] (nexts :mysql-ha/infrastructure delete)))
    (is (= ssh/cleanup-step (first (workflow/wire-fn :mysql-ha/ssh-cleanup delete))))
    (is (= [] (nexts :mysql-ha/ssh-cleanup delete)))))

(deftest a-build-fills-the-placeholder-key-paths
  ;; Every event fills the machine-key paths in preflight so the templates and
  ;; the inventory render the same whichever step scaffolds them; a build gets
  ;; the fixed placeholder, never the operator's home.
  (let [r (workflow/start-step (assoc fixture :green/event :build) {})]
    (is (= 0 (:green/exit r)))
    (is (= "/home/build-placeholder/.ssh/mysql-ha-fixture" (:ssh-private-key-path r)))
    (is (true? (:ssh-keygen r))))
  (testing "opt-out invents no key path"
    (let [r (workflow/start-step (assoc optout :green/event :build) {})]
      (is (= 0 (:green/exit r)))
      (is (nil? (:ssh-private-key-path r)))
      (is (nil? (:ssh-keygen r))))))

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

(deftest build-and-dry-run-never-read-the-state
  ;; A throwing reader proves nothing on these paths reaches the backend.
  (doseq [opts [(assoc fixture :green/event :build)
                (assoc fixture :green/event :create :green/dry-run true)
                (assoc fixture :green/event :delete :green/dry-run true)
                (assoc fixture :green/event :health :green/dry-run true)]]
    (let [r (start-unreadable opts)]
      (is (= 0 (:green/exit r)))
      (is (not (contains? r :mysql-ha/state))))))

(deftest a-real-run-refuses-without-credentials
  (let [result (start (assoc fixture :green/event :create) nil)]
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
    (is (str/includes? (:green/err result) "COLORS_PAR_PROFILE")))
  (testing "and the state is not read for a refused profile, nor for invalid desired state"
    (let [r (start-unreadable (merge fixture credentials {:green/event :delete :compute-prevent-destroy false}))
          _ (is (= 1 (:green/exit (tools/load-infrastructure-step r))) "the read reaches the reader when desired state is valid")
          r (workflow/start-step (merge fixture credentials {:green/event :delete :compute-prevent-destroy false})
                                 {"COLORS_PAR_PROFILE" "elsewhere"}
                                 (fn [_] (throw (Exception. "the reader must not run"))))]
      (is (= 2 (:green/exit r)))
      (is (= 2 (:green/exit (workflow/start-step (merge fixture credentials {:green/event :delete :cluster-nodes 2})
                                                 {} (fn [_] (throw (Exception. "the reader must not run"))))))))))

(deftest the-destroy-guard-holds
  (let [opts (merge fixture credentials {:green/event :delete})
        result (start opts nil)]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COMPUTE_PREVENT_DESTROY")))
  (testing "and lifts for exactly one run"
    (is (= 0 (:green/exit
              (start (merge fixture credentials {:green/event :delete
                                                 :compute-prevent-destroy false})
                     nil))))))

(deftest defaults-do-not-quietly-permit-destruction
  (is (true? (:compute-prevent-destroy workflow/defaults))))

;; --- the Compute Cluster Standard's safety boundaries ------------------------

(deftest a-provider-switch-is-refused-before-the-credentials
  (doseq [event [:create :delete :health]]
    (testing (str "digitalocean selected, vultr recorded, on " (name event))
      (let [r (start (assoc fixture :green/event event :compute-prevent-destroy false)
                     (assoc recorded :provider "vultr"))]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (:green/err r)
                           "state holds a vultr machine; set provider-compute back to vultr and delete first"))
        ;; The validator order is the thing under test: the actionable error,
        ;; not a missing token for the provider that was just selected.
        (is (not (str/includes? (:green/err r) "required credential is not set")))))))

(deftest legacy-state-accepts-only-the-default-provider
  ;; A recorded provider is absent from every pre-adoption state; on the one
  ;; provider this package offers that is the default, and the run proceeds
  ;; to its credentials. A second provider would be refused by selection
  ;; before the state is read, so the other branch of the rule has no
  ;; reachable input here.
  (doseq [event [:create :delete :health]]
    (let [r (start (assoc fixture :green/event event :compute-prevent-destroy false)
                   (dissoc recorded :provider))]
      (is (= 2 (:green/exit r)) (name event))
      (is (not (str/includes? (:green/err r) "state holds")) (name event))
      (is (str/includes? (:green/err r) "required credential is not set") (name event)))))

(deftest a-matching-provider-passes-to-the-credentials
  (let [r (start (assoc fixture :green/event :create) recorded)]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc fixture :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No reader stub: the real `state-output` runs against a work directory
  ;; that holds no stage yet, as a fresh clone's does. It renders the stage,
  ;; writes its local backend and initializes it, and finds no state — or
  ;; fails to launch tofu, which green 3f33f5d reports as its own step error
  ;; carrying :dir. Either way ONCE's `read-state` counts it as no usable
  ;; state, so the create reports its credentials instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "mysql-ha-fresh"}))]
    (try
      (let [r (workflow/start-step (assoc fixture :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_DO_TOKEN"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest an-unreadable-backend-fails-a-real-delete-closed
  ;; Swallowing it is how a teardown ends up converging against 192.0.2.11.
  ;; Preflight hands the read on; `load-infrastructure`, the first step after
  ;; it and before any side effect, is where the delete stops.
  (let [r (start-unreadable (merge fixture credentials
                                   {:green/event :delete :compute-prevent-destroy false}))]
    (is (= 0 (:green/exit r)))
    (is (= {:error "tofu output failed: no backend"} (:mysql-ha/state r)))
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (str/includes? (:green/err l) "could not read the infrastructure state for the delete cleanup"))
      (is (str/includes? (:green/err l) "no backend")))))

(deftest a-real-delete-adopts-the-recorded-cluster
  (let [r (start (merge fixture credentials {:green/event :delete :compute-prevent-destroy false})
                 recorded)
        l (tools/load-infrastructure-step r)]
    (is (= 0 (:green/exit r)))
    (is (= {:params recorded} (:mysql-ha/state r)))
    (is (= 0 (:green/exit l)))
    (is (= recorded (:once/cluster l)))
    (is (= ["203.0.113.11" "203.0.113.12" "203.0.113.13"] (mapv :public-ip (tools/nodes l)))))
  (testing "a readable state without a cluster leaves nothing to clean up"
    (let [l (tools/load-infrastructure-step
             (start (merge fixture credentials {:green/event :delete :compute-prevent-destroy false}) nil))]
      (is (= 0 (:green/exit l)))
      (is (false? (:mysql-ha/infrastructure-present? l))))))

(deftest a-partial-cluster-is-refused-on-a-real-run
  (let [partial (update recorded :nodes #(vec (take 2 %)))
        r (start (merge fixture credentials {:green/event :health}) partial)]
    (is (= 0 (:green/exit r)) "the switch guard reads only the provider")
    (let [l (tools/load-infrastructure-step r)]
      (is (= 1 (:green/exit l)))
      (is (= "the compute stage did not report nodes this package declares: 2" (:green/err l))))))

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
    (doseq [stage ["mysql-ha-infrastructure" "mysql-ha-ansible-local" "mysql-ha-dns" "mysql-ha-ansible"]]
      (is (.isDirectory (io/file root stage)) stage))
    (testing "the backend is written by advice, before the stage runs"
      (is (.exists (io/file root "mysql-ha-infrastructure" "backend.tf.json")))
      (is (.exists (io/file root "mysql-ha-dns" "backend.tf.json"))))
    (testing "nothing that looks like a credential is written"
      (doseq [f (file-seq root) :when (.isFile f)]
        (is (not (re-find #"REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY" (slurp f)))
            (str f))))))
