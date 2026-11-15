#!/usr/bin/env bash
# Mark the project dirty for stop-hook audit when dashboard/check-in files change.
set -euo pipefail
input=$(cat)
file=$(printf '%s' "$input" | node -e "
let s='';
process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>{
  try {
    const j=JSON.parse(s);
    const p=String(j.file_path||j.path||j.file||'');
    process.stdout.write(p);
  } catch { process.stdout.write(''); }
});
")

case "$file" in
  *index.html|*WalletExport.gs|*audit-checkin.mjs|*self-audit-until-clean.mdc)
    mkdir -p .cursor
    printf 'dirty\n' > .cursor/audit-needed
    ;;
esac

printf '{}\n'
exit 0
