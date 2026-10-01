#!/system/bin/sh
# Runs NyxBridge's commands without typing the binary's path:
#   sh ctl.sh status | apply | set KEY VALUE | start | log | report | diag ...
# The logic lives in bin/nyxbridge (Rust); see src/ in the repository.
exec "${0%/*}/bin/nyxbridge" "$@"
