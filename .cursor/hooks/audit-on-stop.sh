#!/usr/bin/env bash
# If dashboard edits happened this session, run check-in audit and auto-continue on failure.
set -euo pipefail
input=$(cat)

status=$(printf '%s' "$input" | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try { const j=JSON.parse(s); process.stdout.write(String(j.status||'')); }
  catch { process.stdout.write(''); }
});
")
loop_count=$(printf '%s' "$input" | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try { const j=JSON.parse(s); process.stdout.write(String(j.loop_count??0)); }
  catch { process.stdout.write('0'); }
});
")

# Only continue after a normal completion; never loop on abort.
if [[ "$status" != "completed" ]]; then
  printf '{}\n'
  exit 0
fi

# No dashboard edits → stay quiet.
if [[ ! -f .cursor/audit-needed ]]; then
  printf '{}\n'
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '{"followup_message":"node is missing — install Node, then run node scripts/audit-checkin.mjs and fix any FAIL lines."}'
  exit 0
fi

set +e
out=$(node scripts/audit-checkin.mjs 2>&1)
code=$?
set -e

if [[ $code -eq 0 ]]; then
  rm -f .cursor/audit-needed
  printf '{}\n'
  exit 0
fi

# Cap is also in hooks.json; still bail cleanly if somehow exhausted.
if [[ "${loop_count}" -ge 5 ]]; then
  printf '{}\n'
  exit 0
fi

# Keep the follow-up short; dump the failures so the next turn can fix them.
fails=$(printf '%s\n' "$out" | grep '^FAIL ' | head -n 12 | sed 's/"/\\"/g' | paste -sd '; ' -)
msg="Self-audit failed — fix every FAIL from node scripts/audit-checkin.mjs, re-run until exit 0, then commit+push. Failures: ${fails}"

node -e "process.stdout.write(JSON.stringify({ followup_message: process.argv[1] }))" "$msg"
exit 0
