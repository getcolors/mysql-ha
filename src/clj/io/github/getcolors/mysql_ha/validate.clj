(ns io.github.getcolors.mysql-ha.validate
  "The provider registry and the desired-state rules it drives.

  The registry is package-owned rather than inherited from ONCE: this package
  ships its own multi-node DigitalOcean template, so coupling its validation to
  ONCE's single-server key set would check for keys no stage here uses and miss
  the ones it does. `k8s` made the same call for the same reason.

  Two credentials reach MySQL — the admin password and the replication
  password — and the design is built to need no third. Nothing in here invents
  one."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [green.providers :as provider-ops]
            [io.github.getcolors.mysql-ha.utils :as utils]))

(def providers
  "Provider slot -> provider name -> what that choice implies.

  `:required` are non-secret keys a template interpolates. `:secrets` arrive
  only through `COLORS_PAR_*`. `:tofu-env` is the subset OpenTofu reads
  natively from the process environment, so a credential never has to be
  rendered into a .tf file sitting in the work directory in plaintext."
  {:provider-compute
   {"digitalocean" {:required [:digitalocean-name :digitalocean-region
                               :digitalocean-size :digitalocean-image
                               :digitalocean-ssh-keys :digitalocean-vpc-mode]
                    :secrets [:do-token]
                    :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}}

   :provider-dns
   {"cloudflare" {:required [:cloudflare-zone]
                  :secrets [:cloudflare-api-token]
                  :tofu-env {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}}}

   :provider-backend
   {"local" {:required [] :secrets [] :tofu-env {}}
    "s3" {:required [:s3-bucket :s3-region] :secrets [] :tofu-env {}}
    ;; R2 is S3-compatible, so it authenticates through the AWS chain. Naming
    ;; the keys in backend.tf.json would also copy them into .terraform/.
    "r2" {:required [:r2-bucket :r2-endpoint]
          :secrets [:r2-access-key-id :r2-secret-access-key]
          :tofu-env {:r2-access-key-id "AWS_ACCESS_KEY_ID"
                     :r2-secret-access-key "AWS_SECRET_ACCESS_KEY"}}}})

(def slots [:provider-compute :provider-dns :provider-backend])

(def own-required
  [:profile :workdir
   :cluster-host :cluster-nodes
   :digitalocean-ssh-private-key :digitalocean-ssh-sources
   :digitalocean-client-sources
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

(def profile-par (green-cli/par-name :profile))

(defn env-errors
  "`COLORS_PAR_PROFILE` keys this deployment's remote state. Overlaying it can
  only point one deployment at another's, so it is refused rather than honoured."
  [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set. mysql-ha takes profile from colors.yml only.")]))

(defn- slot-keys [opts field]
  (provider-ops/slot-keys providers opts slots field))

(defn- missing [opts ks]
  (provider-ops/missing-keys opts ks))

(def host-re
  #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def uuid-re
  #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
(def cidr-re #"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}/[0-9]{1,2}$")
(def buffer-pool-re #"^[0-9]+[KMG]$")
(def oncalendar-re #"^[-*0-9]+-[-*0-9]+-[-*0-9]+ [:0-9*/]+$")

(defn- positive-int? [x] (and (integer? x) (pos? x)))

(defn- cidr-list-errors [opts k]
  (let [v (get opts k)]
    (cond
      (placeholder? v) nil
      (not (sequential? v)) [(str k " must be a list of CIDRs")]
      (empty? v) [(str k " must list at least one CIDR")]
      :else (for [c v :when (not (re-matches cidr-re (str c)))]
              (str k " entry " (pr-str c) " is not a CIDR")))))

(defn state-errors
  "Everything wrong with `opts` that does not depend on a credential. Empty
  means the desired state renders."
  [opts]
  (vec
   (concat
    (map #(str % " is required")
         (missing opts (concat own-required (slot-keys opts :required))))
    (for [slot slots
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
    (when-not (= 3 (:cluster-nodes opts))
      [":cluster-nodes must be 3; a Group Replication majority needs an odd group and the budget is three droplets"])
    (when-not (= "default" (:digitalocean-vpc-mode opts))
      [":digitalocean-vpc-mode must be default; the VPC is discovered at run time and is never desired state"])
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
    (cidr-list-errors opts :digitalocean-ssh-sources)
    (cidr-list-errors opts :digitalocean-client-sources))))

(defn secret-errors
  "Credentials a real run needs that no `COLORS_PAR_*` variable supplied.

  `health` reads remote state and talks to the nodes over SSH; every MySQL
  query it makes runs on the node against its local socket, so it needs the
  provider credentials and none of the database ones."
  [opts]
  (let [ks (if (= :health (:green/event opts))
             (slot-keys opts :secrets)
             (concat (slot-keys opts :secrets) own-secrets))]
    (mapv #(str "required credential is not set: " (green-cli/par-name %))
          (distinct (missing opts ks)))))
