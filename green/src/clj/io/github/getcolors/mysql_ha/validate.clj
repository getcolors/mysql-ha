(ns io.github.getcolors.mysql-ha.validate
  "The provider registry and the desired-state rules it drives.

  The compute registry is package-owned — this package ships its own
  multi-node DigitalOcean template — and the operations over it are ONCE's
  `compute-cluster` namespace, the one implementation of the Compute Cluster
  Standard: selection, the required keys, the source lists, the provider
  rules, the network mode and the topology are checked there over `spec`,
  never copied here. What stays here is what only this package knows: the
  fixed member count, the discovered VPC, and every MySQL rule.

  Two credentials reach MySQL — the admin password and the replication
  password — and the design is built to need no third. Nothing in here invents
  one."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [green.providers :as provider-ops]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as cluster]
            [io.github.getcolors.mysql-ha.utils :as utils]))

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are non-secret keys the template interpolates. `:secrets` arrive
  only through `COLORS_PAR_*`. `:tofu-env` is the subset OpenTofu reads
  natively from the process environment, so a credential never has to be
  rendered into a .tf file sitting in the work directory in plaintext.
  `:network` is `:discovered`: the region's default VPC, never one this
  package owns. `digitalocean-ssh-keys` stays a required literal key; the SSH
  Keypair Standard is a separate adoption."
  {"digitalocean" {:required [:digitalocean-name :digitalocean-region
                              :digitalocean-size :digitalocean-image
                              :digitalocean-ssh-keys :digitalocean-vpc-mode]
                   :secrets [:do-token]
                   :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}
                   :network {:mode :discovered}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered."
  "digitalocean")

(def spec
  "How this package describes itself to ONCE's `compute-cluster`. One
  homogeneous role of `cluster-nodes` members, whose fallback addresses start
  at offset 11 so that `build` renders the same 192.0.2.11-13 and
  10.110.0.11-13 it always did, with 192.0.2.10 left to the reserved IP. The
  fallback subnet stands in for the discovered VPC's range on a build; on a
  real run the range is the compute state's `vpc_ip_range`."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources" "client-sources"] :may-be-empty []}
   :roles [{:role nil :count-key :cluster-nodes :count 3 :fallback-offset 11}]
   :fallback-subnet "10.110.0.0/20"})

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
   {"local" {:required [] :secrets [] :tofu-env {}}
    "s3" {:required [:s3-bucket :s3-region] :secrets [] :tofu-env {}}
    ;; R2 is S3-compatible, so it authenticates through the AWS chain. Naming
    ;; the keys in backend.tf.json would also copy them into .terraform/.
    "r2" {:required [:r2-bucket :r2-endpoint]
          :secrets [:r2-access-key-id :r2-secret-access-key]
          :tofu-env {:r2-access-key-id "AWS_ACCESS_KEY_ID"
                     :r2-secret-access-key "AWS_SECRET_ACCESS_KEY"}}}})

(def slots [:provider-compute :provider-dns :provider-backend])

(def own-slots
  "The slots this package selects and checks itself; the compute slot is
  ONCE's."
  [:provider-dns :provider-backend])

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
  "Everything wrong with `opts` that does not depend on a credential. Empty
  means the desired state renders. The missing keys are this package's, the
  selected compute provider's (ONCE's `compute/required-keys`) and the other slots';
  the package's own rules follow; the Compute Cluster Standard's — selection,
  the source lists, the provider and network rules, the topology — are ONCE's
  over `spec` and come last."
  [opts]
  (vec
   (concat
    (map #(str % " is required")
         (missing opts (concat own-required
                               (compute/required-keys spec opts)
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
    (cluster/state-errors spec opts))))

(defn secret-errors
  "Credentials a real run needs that no `COLORS_PAR_*` variable supplied.

  `health` reads remote state and talks to the nodes over SSH; every MySQL
  query it makes runs on the node against its local socket, so it needs the
  provider credentials and none of the database ones."
  [opts]
  (let [ks (if (= :health (:green/event opts))
             (slot-keys opts slots :secrets)
             (concat (slot-keys opts slots :secrets) own-secrets))]
    (mapv #(str "required credential is not set: " (green-cli/par-name %))
          (distinct (missing opts ks)))))
