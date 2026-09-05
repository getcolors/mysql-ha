(ns io.github.getcolors.mysql-ha.ssh-config-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.mysql-ha.ssh-config :as ssh-config]))

(def opts {:profile "mysql-ha-digitalocean" :cluster-nodes 3})

(deftest the-deployment-claims-one-alias-per-member-and-the-bare-profile
  ;; `ssh mysql-ha-digitalocean` is what the standard promises; the numbered
  ;; aliases are what make a group operable, since half of running one is
  ;; reaching a specific member.
  (is (= ["mysql-ha-digitalocean" "mysql-ha-digitalocean-0"
          "mysql-ha-digitalocean-1" "mysql-ha-digitalocean-2"]
         (ssh-config/aliases opts))))

(deftest the-identity-file-stays-unexpanded
  (is (= "~/.ssh/mysql-ha-digitalocean" (ssh-config/identity-file opts))))

(deftest a-foreign-stanza-is-found-for-any-alias-not-just-the-first
  (let [lines (str/split-lines "Host something\n  HostName 1.2.3.4\n\nHost mysql-ha-digitalocean-2\n  HostName 5.6.7.8\n")]
    (is (nil? (ssh-config/foreign-stanza-line lines "mysql-ha-digitalocean")))
    (is (= 4 (ssh-config/foreign-stanza-line lines "mysql-ha-digitalocean-2")))))

(deftest our-own-managed-block-is-not-foreign-for-any-alias-in-it
  ;; One block, marked with the profile, holding a stanza per member. Deriving
  ;; the marker from the stanza being searched — which a single-node package
  ;; can get away with — makes the check hunt for
  ;; `# BEGIN mysql-ha-digitalocean-0 …`, never find it, and refuse to
  ;; converge because of a block this package wrote itself.
  (let [lines (str/split-lines
               (str "# BEGIN mysql-ha-digitalocean ANSIBLE MANAGED BLOCK\n"
                    "Host mysql-ha-digitalocean\n  HostName 1.2.3.4\n"
                    "Host mysql-ha-digitalocean-0\n  HostName 1.2.3.4\n"
                    "Host mysql-ha-digitalocean-1\n  HostName 1.2.3.5\n"
                    "Host mysql-ha-digitalocean-2\n  HostName 1.2.3.6\n"
                    "# END mysql-ha-digitalocean ANSIBLE MANAGED BLOCK\n"))
        marker "mysql-ha-digitalocean"]
    (doseq [a (ssh-config/aliases opts)]
      (is (nil? (ssh-config/foreign-stanza-line lines a marker))
          (str a " inside our own block was read as foreign")))))

(deftest a-member-stanza-outside-our-block-is-still-foreign
  (let [lines (str/split-lines
               (str "# BEGIN mysql-ha-digitalocean ANSIBLE MANAGED BLOCK\n"
                    "Host mysql-ha-digitalocean\n  HostName 1.2.3.4\n"
                    "# END mysql-ha-digitalocean ANSIBLE MANAGED BLOCK\n"
                    "Host mysql-ha-digitalocean-1\n  HostName 9.9.9.9\n"))]
    (is (= 5 (ssh-config/foreign-stanza-line lines "mysql-ha-digitalocean-1" "mysql-ha-digitalocean")))))

(deftest a-global-option-above-the-first-host-blocks-the-run
  ;; The block is inserted at BOF, so it would capture such an option into one
  ;; stanza and silently narrow a setting that applied to every host.
  (is (= 1 (ssh-config/leading-option-line ["ServerAliveInterval 60" "Host x"])))
  (is (nil? (ssh-config/leading-option-line ["# a comment" "" "Host x" "  User root"])))
  (testing "an option below a Host line belongs to that host and is fine"
    (is (nil? (ssh-config/leading-option-line ["Host x" "  ServerAliveInterval 60"])))))

(deftest the-refusal-is-reported-as-a-failed-step
  (let [home (str (java.nio.file.Files/createTempDirectory
                   "mysql-ha-ssh-config" (into-array java.nio.file.attribute.FileAttribute [])))
        config (java.io.File. (str home "/.ssh/config"))]
    (.mkdirs (.getParentFile config))
    (spit config "Host mysql-ha-digitalocean-1\n  HostName 9.9.9.9\n")
    (with-redefs [ssh-config/config-path (constantly config)]
      (let [refused (ssh-config/preflight! opts)]
        (is (= 1 (:green/exit refused)))
        (is (str/includes? (:green/err refused) "mysql-ha-digitalocean-1"))))
    (spit config "# only a comment\nHost other\n  HostName 1.1.1.1\n")
    (with-redefs [ssh-config/config-path (constantly config)]
      (is (= 0 (:green/exit (ssh-config/preflight! opts) 0))))))
