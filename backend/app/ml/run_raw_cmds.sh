#!/usr/bin/env bash
set -euo pipefail

INFILE="D:\EthicalHacking\smartfuzzer\node-crawler\src\payloads_vulners.txt"
OUTDIR="responses_$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$OUTDIR"

echo "[+] starting request capture..."
i=0

while IFS= read -r line || [[ -n "$line" ]] ; do
[[-z"${line// }"]] && continue
[["${line:):1}"=="#"]] && continue

((i++))
echo "[+] Requesting #$i: $line"

curl -s -i --max-time 20 $line > "$OUTDIR/response_$i.txt"  2>&1

done < "$INFILE"

echo "[✓] done.  Saved all responses in: $OUTDIR"

