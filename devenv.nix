{ pkgs, ... }:
{
  languages.clojure.enable = true;
  languages.opentofu.enable = true;
  packages = with pkgs; [
    ansible babashka curl doctl gh git jq openssh
    # An 8.x client, for connecting to the cluster through its endpoint from the
    # operator's machine. Not `mysql-client` (nixpkgs has removed it) and not
    # MariaDB's client, which cannot speak caching_sha2_password — MySQL 8's
    # default authentication plugin, and the one this cluster's accounts use.
    mysql84
  ];
}
