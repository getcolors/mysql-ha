(ns io.github.getcolors.mysql-ha.validate
  "Application rules backed by colors-compute."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [green.providers :as provider-ops]
            [io.github.getcolors.compute :as library]
            [io.github.getcolors.compute-planning :as planning]
            [io.github.getcolors.compute-ssh :as compute-ssh]
            [io.github.getcolors.mysql-ha.compute :as compute]
            [io.github.getcolors.mysql-ha.utils :as utils]))

(defn- entry-keys [entry] (-> entry (update :required #(mapv keyword %)) (update :secrets #(mapv keyword %))))
(def compute-providers (into {} (map (fn [[name entry]] [(clojure.core/name name) (entry-keys entry)]) (:compute library/registry))))
(def default-compute-provider "digitalocean")

(def providers
  "Provider slot -> provider name -> what that choice implies. The compute
  slot is the registry above, so the OpenTofu environment and the secrets are
  read from one place whichever slot a stage asks for."
  {:provider-compute compute-providers

   :provider-dns
   {"cloudflare" {:required [:cloudflare-zone]
                  :secrets [:cloudflare-api-token]
                  :tofu-env {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}}}

   :provider-backend
   (into {} (map (fn [[name entry]]
                   [(clojure.core/name name) (cond-> (entry-keys entry)
                                             (= name :r2) (assoc :tofu-env {:r2-access-key-id "AWS_ACCESS_KEY_ID" :r2-secret-access-key "AWS_SECRET_ACCESS_KEY"}))])
                 (:backend library/registry)))})

(def slots [:provider-compute :provider-dns :provider-backend])

(def own-slots
  "The slots this package selects and checks itself; the compute slot is
  ONCE's."
  [:provider-dns :provider-backend])

(def own-required
  [:profile :workdir
   :cluster-host :cluster-nodes
   :cloudflare-proxied
   :mysql-port :mysql-group-port :mysql-group-name
   :mysql-admin-user :mysql-replication-user
   :mysql-innodb-buffer-pool-size
   :backup-r2-bucket :backup-r2-endpoint :backup-r2-region :backup-r2-prefix
   :backup-snapshot-oncalendar :backup-restore-check-oncalendar
   :backup-binlog-upload-interval :backup-retention-days
   :backup-restore-max-lag-seconds
   :heartbeat-interval :endpoint-poll-interval])

(def own-secrets
  "The two database credentials the brief allows, plus the separate R2 key pair
  the nodes use for the backup bucket. The backup key pair is deliberately not
  the state-backend key pair: the state bucket and the backup bucket are
  different blast radii."
  [:mysql-admin-password :mysql-replication-password
   :backup-r2-access-key-id :backup-r2-secret-access-key])

(defn placeholder? [x] (provider-ops/placeholder? x))

(defn keygen? [opts]
  (try (= "managed" (:mode (compute-ssh/mode opts))) (catch Exception _ true)))

(def profile-par (green-cli/par-name :profile))

(defn env-errors
  "`COLORS_PAR_PROFILE` keys this deployment's remote state. Overlaying it can
  only point one deployment at another's, so it is refused rather than honoured."
  [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set. mysql-ha takes profile from colors.yml only.")]))

(defn- slot-keys [opts slots field]
  (provider-ops/slot-keys providers opts slots field))

(defn- missing [opts ks]
  (provider-ops/missing-keys opts ks))

(def host-re
  #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def uuid-re
  #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
(def buffer-pool-re #"^[0-9]+[KMG]$")
(def oncalendar-re #"^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$")

(defn- positive-int? [x] (and (integer? x) (pos? x)))

(defn state-errors
  "Application constraints plus pure library capability validation."
  [opts]
  (vec
   (concat
    (map #(str % " is required")
         (missing opts (concat own-required
                               (slot-keys opts own-slots :required))))
    (for [slot own-slots
          :let [p (get opts slot)]
          :when (not (contains? (get providers slot) p))]
      (str "unsupported " slot " " (pr-str p)))
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (boolean? (:cloudflare-proxied opts))
      [":cloudflare-proxied must be true or false"])
    (when (true? (:cloudflare-proxied opts))
      [":cloudflare-proxied must be false; Cloudflare's proxy does not carry the MySQL protocol"])
    (when-not (or (placeholder? (:cluster-host opts))
                  (re-matches host-re (str (:cluster-host opts))))
      [":cluster-host must be a fully qualified hostname"])
    (when-not (or (placeholder? (:cluster-host opts))
                  (placeholder? (:cloudflare-zone opts))
                  (str/ends-with? (str (:cluster-host opts))
                                  (str "." (:cloudflare-zone opts))))
      [":cluster-host must sit inside :cloudflare-zone"])
    ;; Opt-out mode reaches the members with the operator's own key, so the
    ;; path to it is desired state there; keygen mode names the generated key
    ;; itself and must not be asked for one.
    (when (and (not (keygen? opts))
               (placeholder? (:private_key_path (compute-ssh/mode opts))))
      [":ssh-private-key-path is required for external SSH access"])
    (when-not (= 3 (:cluster-nodes opts))
      [":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets"])
    (when-not (or (placeholder? (:mysql-group-name opts))
                  (re-matches uuid-re (str (:mysql-group-name opts))))
      [":mysql-group-name must be a UUID; MySQL rejects anything else as a group name"])
    (for [k [:mysql-port :mysql-group-port :backup-retention-days
             :backup-restore-max-lag-seconds]
          :when (not (positive-int? (get opts k)))]
      (str k " must be a positive integer"))
    (when (= (:mysql-port opts) (:mysql-group-port opts))
      [":mysql-group-port must differ from :mysql-port"])
    (when-not (or (placeholder? (:mysql-innodb-buffer-pool-size opts))
                  (re-matches buffer-pool-re (str (:mysql-innodb-buffer-pool-size opts))))
      [":mysql-innodb-buffer-pool-size must be a size such as 1G"])
    (for [k [:heartbeat-interval :endpoint-poll-interval :backup-binlog-upload-interval]
          :when (and (not (placeholder? (get opts k)))
                     (not (utils/duration? (get opts k))))]
      (str k " must be a systemd duration such as 10s or 1min"))
    (for [k [:backup-snapshot-oncalendar :backup-restore-check-oncalendar]
          :when (and (not (placeholder? (get opts k)))
                     (not (re-matches oncalendar-re (str (get opts k)))))]
      (str k " must be a systemd OnCalendar expression such as *-*-* 01:00:00"))
    (when (and (not (placeholder? (:backup-r2-bucket opts)))
               (not (placeholder? (:r2-bucket opts)))
               (= (str (:backup-r2-bucket opts)) (str (:r2-bucket opts))))
      [":backup-r2-bucket must not be the state bucket"])
    (library/validate opts)
    (when (empty? (library/validate opts))
      (try (planning/plan-deployment opts (compute/topology opts) (compute/requirements opts)) []
           (catch Exception error [(.getMessage error)]))))))

(defn secret-errors
  "Credentials a real run needs that no `COLORS_PAR_*` variable supplied.

  `health` reads remote state and talks to the nodes over SSH; every MySQL
  query it makes runs on the node against its local socket, so it needs the
  provider credentials and none of the database ones."
  [opts]
  (let [ks (if (= :health (:green/event opts))
             (slot-keys opts own-slots :secrets)
             (concat (slot-keys opts own-slots :secrets) own-secrets))]
    (mapv #(str "required credential is not set: " (green-cli/par-name %))
          (distinct (missing opts ks)))))
