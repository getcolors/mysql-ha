declare module "*.tf" { const content: string; export default content; }
declare module "*.yml" { const content: string; export default content; }
declare module "*.yaml" { const content: string; export default content; }
declare module "*.cfg" { const content: string; export default content; }
declare module "*.cnf" { const content: string; export default content; }
declare module "*.env" { const content: string; export default content; }
declare module "*/apparmor-local" { const content: string; export default content; }
declare module "*/mysql-ha-binlog-archive" { const content: string; export default content; }
declare module "*/mysql-ha-binlog-upload" { const content: string; export default content; }
declare module "*/mysql-ha-endpoint" { const content: string; export default content; }
declare module "*/mysql-ha-health" { const content: string; export default content; }
declare module "*/mysql-ha-heartbeat" { const content: string; export default content; }
declare module "*/mysql-ha-lib" { const content: string; export default content; }
declare module "*/mysql-ha-restore-check" { const content: string; export default content; }
declare module "*/mysql-ha-snapshot" { const content: string; export default content; }
// package-once-red's tools.ts imports these text resources; the declarations
// let `tsc --noEmit` follow the dependency the same way clickstack's do.
declare module "*.ini" { const content: string; export default content; }
declare module "*/authorized-keys" { const content: string; export default content; }
declare module "*/deploy" { const content: string; export default content; }
declare module "*/once" { const content: string; export default content; }
