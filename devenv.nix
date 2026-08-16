{ pkgs, ... }:
{
  languages.clojure.enable = true;
  languages.opentofu.enable = true;
  packages = with pkgs; [
    ansible babashka curl doctl gh git jq openssh mysql-client rclone
  ];
}
