#!/usr/bin/env bash
set -euo pipefail

INFILE="/home/arunexploit/develop/Smartfuzzier/node-crawler/src/payloads_vulners.txt"   # path to your file (one curl command per line)
OUTDIR="responses_$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUTDIR"

if [[ ! -f "$INFILE" ]]; then
  echo "ERROR: payloads file not found: $INFILE" >&2
  exit 2
fi

echo "[+] reading payloads from: $INFILE"
i=1
pids=()

while IFS= read -r raw_line || [[ -n "${raw_line:-}" ]]; do
  # trim whitespace
  line="$(printf '%s' "$raw_line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  # skip blank or commented lines
  if [[ -z "$line" || "${line:0:1}" == "#" ]]; then
    continue
  fi

  num=$(printf '%02d' "$i")
  outfile="${OUTDIR}/response${num}.html"
  errfile="${OUTDIR}/response${num}.err"
  metafile="${OUTDIR}/response${num}.meta"

  echo "[+] starting #${num}: $line"

  # save meta header
  {
    echo "timestamp_utc: $(date -u --rfc-3339=seconds)"
    echo "input_line: $line"
  } > "$metafile"

  # run each command in background, capture stdout (headers+body) to .html and stderr to .err
  # Use bash -c "exec $line" so quoting in the line is respected.
  bash -c "set -o noglob; exec $line" > "$outfile" 2> "$errfile" &
  pids+=($!)

  i=$((i+1))
done < "$INFILE"

# wait for all background jobs to finish
echo "[+] waiting for ${#pids[@]} jobs to finish..."
for pid in "${pids[@]}"; do
  if wait "$pid"; then
    : # success
  else
    : # keep going, errors recorded in .err files
  fi
done

echo "[✓] all done. Results in: $OUTDIR"
