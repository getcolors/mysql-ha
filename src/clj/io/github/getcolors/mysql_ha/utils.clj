(ns io.github.getcolors.mysql-ha.utils
  "Launcher contract, node topology, and the small derivations several
  namespaces share.

  The topology is a pure function of desired state: three homogeneous members
  numbered from one. Nothing here reaches a network, so tests can assert the
  whole shape of the cluster without provisioning anything."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]))

(def contract
  "Minimum mysql-ha contract a standalone launcher must find. Bump on any
  change a launcher pinned to an older commit could not survive."
  1)

(defn node-count [opts]
  (let [n (:cluster-nodes opts)]
    (if (integer? n) n 3)))

(defn ordinals [opts]
  (range 1 (inc (node-count opts))))

(defn node-name
  "The DigitalOcean droplet name for member `ordinal`, and the Ansible
  inventory host alias. One name, so a droplet in the console and a host in a
  play recap are obviously the same thing."
  [opts ordinal]
  (str (:digitalocean-name opts) "-node-" ordinal))

(defn node-names [opts]
  (mapv #(node-name opts %) (ordinals opts)))

(defn server-id
  "MySQL `server_id`. Distinct per member and stable across rebuilds, because
  it is derived from the ordinal rather than from an address."
  [ordinal]
  (+ 100 ordinal))

(defn connection-server-id
  "The pseudo-replica id `mysqlbinlog --read-from-remote-server` registers
  with. It must not collide with any real member's `server_id`."
  [ordinal]
  (+ 200 ordinal))

(defn node-host
  "`node-2.my-ha.bigconfig.space` — the per-member administrative name. The
  cluster host itself always points at the reserved IP, never at a member."
  [opts ordinal]
  (str "node-" ordinal "." (:cluster-host opts)))

(defn record-name
  "The Cloudflare record name relative to nothing — Cloudflare 5.x takes the
  fully qualified name, so this is the FQDN with the trailing dot removed."
  [host]
  (str/replace (str host) #"\.$" ""))

(defn tool-dir [opts tool]
  (green-cli/stage-dir opts tool {:default-profile "mysql-ha"}))

(defn backup-prefix
  "Object-key prefix inside the backup bucket, without a trailing slash."
  [opts]
  (str/replace (str (:backup-r2-prefix opts)) #"/+$" ""))

(def ^:private duration-re #"^[0-9]+(?:ms|s|m|h|min|d)$")

(defn duration? [x]
  (boolean (and (string? x) (re-matches duration-re x))))
