(ns io.github.getcolors.mysql-ha.validate-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def optout
  (green-cli/read-state "optout.yml" (slurp "test/fixtures/optout.yml")))

(deftest the-fixture-is-renderable
  (is (= [] (validate/state-errors fixture))))

(deftest both-keypair-modes-are-renderable
  ;; The SSH Keypair Standard has two modes and conformance means both hold.
  (is (= [] (validate/state-errors optout)))
  (is (validate/keygen? fixture))
  (is (not (validate/keygen? optout))))

(deftest the-machine-key-is-never-required
  ;; Its absence is keygen mode, not a missing key.
  (is (not-any? #(re-find #"digitalocean-ssh-keys" %) (validate/state-errors fixture))))

(deftest the-private-key-path-is-desired-state-in-opt-out-mode-only
  (is (some #{":digitalocean-ssh-private-key is required when digitalocean-ssh-keys is supplied"}
            (validate/state-errors (dissoc optout :digitalocean-ssh-private-key))))
  (testing "keygen mode names the generated key itself and asks for no path"
    (is (= [] (validate/state-errors (dissoc fixture :digitalocean-ssh-private-key))))))

(deftest every-required-key-is-required
  (doseq [k (concat validate/own-required
                    (get-in validate/compute-providers ["digitalocean" :required]))]
    (testing (str k)
      (is (some #(re-find (re-pattern (str k " is required")) %)
                (validate/state-errors (dissoc fixture k)))))))

(deftest the-profile-parameter-is-refused
  (is (nil? (validate/env-errors {})))
  (is (nil? (validate/env-errors {"COLORS_PAR_PROFILE" ""})))
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "somewhere-else"}))))

(deftest the-spec-describes-one-homogeneous-role-on-a-discovered-network
  ;; The Compute Cluster Standard's spec is data ONCE reads; this is the one
  ;; place its content is asserted, so a drift in any colour is a test
  ;; failure and not a rendered surprise.
  (is (= [] (cluster/spec-errors validate/spec)))
  (is (= ["digitalocean"] (keys (:registry validate/spec))))
  (is (= "digitalocean" (:default validate/spec)))
  (is (= {:mode :discovered} (get-in validate/spec [:registry "digitalocean" :network])))
  (is (= ["ssh-sources" "client-sources"] (get-in validate/spec [:sources :non-empty])))
  (is (= [{:role nil :count-key :cluster-nodes :count 3 :fallback-offset 11}]
         (:roles validate/spec)))
  (is (= "10.110.0.0/20" (:fallback-subnet validate/spec)))
  (is (= [] (cluster/topology-errors validate/spec fixture))))

(deftest the-node-budget-is-three
  (is (seq (validate/state-errors (assoc fixture :cluster-nodes 2))))
  (is (seq (validate/state-errors (assoc fixture :cluster-nodes 5))))
  (testing "a count that is not a positive integer is ONCE's to refuse too"
    (is (some #{":cluster-nodes must be a positive integer"}
              (validate/state-errors (assoc fixture :cluster-nodes "3"))))))

(deftest the-vpc-is-never-desired-state
  (is (seq (validate/state-errors (assoc fixture :digitalocean-vpc-mode "managed"))))
  (testing "a pinned VPC is refused by the standard's discovered-network rule"
    (is (seq (validate/state-errors (assoc fixture :digitalocean-vpc-uuid "00000000-0000-0000-0000-000000000000"))))
    (is (seq (validate/state-errors (assoc fixture :digitalocean-vpc-cidr "10.110.0.0/20"))))))

(deftest the-group-name-must-be-a-uuid
  (is (seq (validate/state-errors (assoc fixture :mysql-group-name "mysql-ha"))))
  (is (= [] (validate/state-errors
             (assoc fixture :mysql-group-name
                    "00000000-1111-2222-3333-444444444444")))))

(deftest the-endpoint-must-live-in-the-managed-zone
  (is (seq (validate/state-errors (assoc fixture :cluster-host "my-ha.example.org"))))
  (is (seq (validate/state-errors (assoc fixture :cluster-host "not a hostname")))))

(deftest the-proxy-cannot-carry-mysql
  (is (seq (validate/state-errors (assoc fixture :cloudflare-proxied true)))))

(deftest the-destroy-guard-must-be-a-boolean
  (is (seq (validate/state-errors (assoc fixture :compute-prevent-destroy "true")))))

(deftest backups-may-not-share-the-state-bucket
  (is (seq (validate/state-errors
            (assoc fixture :backup-r2-bucket (:r2-bucket fixture))))))

(deftest source-lists-must-be-cidrs
  ;; The messages are ONCE's: the source lists are the Compute Provider
  ;; Standard's, checked over `spec`.
  (is (some #{":digitalocean-ssh-sources must list at least one CIDR"}
            (validate/state-errors (assoc fixture :digitalocean-ssh-sources []))))
  (is (some #{":digitalocean-client-sources entry \"203.0.113.7\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors
             (assoc fixture :digitalocean-client-sources ["203.0.113.7"]))))
  (testing "a string is a list, the way an overlay carries one"
    (is (= [] (validate/state-errors
               (assoc fixture :digitalocean-ssh-sources "203.0.113.7/32, 198.51.100.0/24"))))))

(deftest schedules-and-durations-are-checked
  (is (seq (validate/state-errors (assoc fixture :heartbeat-interval "often"))))
  (is (seq (validate/state-errors
            (assoc fixture :backup-snapshot-oncalendar "daily at one"))))
  (is (seq (validate/state-errors
            (assoc fixture :mysql-innodb-buffer-pool-size "lots")))))

(deftest the-group-port-cannot-be-the-client-port
  (is (seq (validate/state-errors (assoc fixture :mysql-group-port 3306)))))

(deftest a-real-run-needs-exactly-the-credentials-the-design-allows
  (let [errors (validate/secret-errors (assoc fixture :green/event :create))]
    (is (= #{"COLORS_PAR_MYSQL_ADMIN_PASSWORD"
             "COLORS_PAR_MYSQL_REPLICATION_PASSWORD"
             "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID"
             "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY"
             "COLORS_PAR_DO_TOKEN"
             "COLORS_PAR_CLOUDFLARE_API_TOKEN"}
           (set (map #(last (re-find #"(COLORS_PAR_\S+)" %)) errors)))
        "the package must not invent a credential beyond the two it is given")))

(deftest health-needs-no-database-credential
  (let [errors (validate/secret-errors (assoc fixture :green/event :health))]
    (is (not-any? #(re-find #"MYSQL" %) errors))
    (is (some #(re-find #"DO_TOKEN" %) errors))))

(deftest supplied-credentials-are-not-reported-missing
  (is (= [] (validate/secret-errors
             (merge fixture {:green/event :create
                             :mysql-admin-password "a"
                             :mysql-replication-password "b"
                             :backup-r2-access-key-id "c"
                             :backup-r2-secret-access-key "d"
                             :do-token "e"
                             :cloudflare-api-token "f"})))))

(deftest only-the-providers-this-package-implements-are-accepted
  (is (some #{":provider-compute must be one of digitalocean"}
            (validate/state-errors (assoc fixture :provider-compute "hcloud"))))
  (is (seq (validate/state-errors (assoc fixture :provider-dns "yandex"))))
  (is (= [] (validate/state-errors (assoc fixture :provider-backend "local")))))
