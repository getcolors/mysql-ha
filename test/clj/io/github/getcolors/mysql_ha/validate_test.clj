(ns io.github.getcolors.mysql-ha.validate-test
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.mysql-ha.validate :as validate]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(deftest the-fixture-is-renderable
  (is (= [] (validate/state-errors fixture))))

(deftest every-required-key-is-required
  (doseq [k validate/own-required]
    (testing (str k)
      (is (some #(re-find (re-pattern (str k " is required")) %)
                (validate/state-errors (dissoc fixture k)))))))

(deftest the-profile-parameter-is-refused
  (is (nil? (validate/env-errors {})))
  (is (nil? (validate/env-errors {"COLORS_PAR_PROFILE" ""})))
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "somewhere-else"}))))

(deftest the-node-budget-is-three
  (is (seq (validate/state-errors (assoc fixture :cluster-nodes 2))))
  (is (seq (validate/state-errors (assoc fixture :cluster-nodes 5)))))

(deftest the-vpc-is-never-desired-state
  (is (seq (validate/state-errors (assoc fixture :digitalocean-vpc-mode "managed")))))

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
  (is (seq (validate/state-errors (assoc fixture :digitalocean-ssh-sources []))))
  (is (seq (validate/state-errors
            (assoc fixture :digitalocean-client-sources ["203.0.113.7"]))))
  (is (seq (validate/state-errors
            (assoc fixture :digitalocean-ssh-sources "203.0.113.7/32")))))

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
  (is (seq (validate/state-errors (assoc fixture :provider-compute "hcloud"))))
  (is (seq (validate/state-errors (assoc fixture :provider-dns "yandex"))))
  (is (= [] (validate/state-errors (assoc fixture :provider-backend "local")))))
