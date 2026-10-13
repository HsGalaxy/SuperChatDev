#!/bin/sh
# Read-only checks; never dump full environment or secrets.
echo "CORE MCP runtime doctor"
id
printf 'open files soft='; ulimit -Sn 2>&1
printf 'open files hard='; ulimit -Hn 2>&1
for t in node python3 git bash rustc cargo rg; do
  command -v "$t" || printf '%s missing\n' "$t"
done
rustc --version 2>&1 || :
cargo --version 2>&1 || :
awk '/NoNewPrivs:/ {print "NoNewPrivs=" $2}' /proc/self/status
echo "Run under job_start to verify gateway runner environment."
