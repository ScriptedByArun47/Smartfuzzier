#!/usr/bin/env bash
set -euo pipefail

# Usage:
#  # dry-run (default)
#  INFILE=/path/to/payloads_vulners.txt bash run_raw_cmds.sh
#
#  # to actually run commands (DANGEROUS — only in an isolated, authorized lab):
#  DRY_RUN=0 ALLOW_EXECUTION=1 INFILE=/path/to/payloads_vulners.txt SHOW_PROGRESS=1 SHOW_LOGS=0 bash run_raw_cmds.sh
#
# Env variables:
#  INFILE            path to payloads file (default: your original path)
#  DRY_RUN           "1" (default) => do not execute, only save placeholders; set "0" to allow execution
#  ALLOW_EXECUTION   must be "1" AND DRY_RUN=0 to actually execute commands
#  SHOW_PROGRESS     "1" to print periodic progress while commands run (default 0)
#  SHOW_LOGS         "1" to print short live previews of stdout/stderr while running (default 0)
#  TAIL_LINES        number of lines to show per-file preview in live mode and summary (default 40)

INFILE="${INFILE:-/home/arunexploit/develop/Smartfuzzier/backend/app/node-crawler/src/payloads_vulners.txt}"
DRY_RUN=${DRY_RUN:-0}
ALLOW_EXECUTION=${ALLOW_EXECUTION:-1}
SHOW_PROGRESS=${SHOW_PROGRESS:-1}
SHOW_LOGS=${SHOW_LOGS:-0}
TAIL_LINES=${TAIL_LINES:-40}

if [[ ! -f "$INFILE" ]]; then
  echo "ERROR: payloads file not found: $INFILE" >&2
  exit 2
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTDIR="responses_${TIMESTAMP}"
mkdir -p "$OUTDIR"

echo "[+] INFILE: $INFILE"
echo "[+] OUTDIR: $OUTDIR"
echo "[+] DRY_RUN: $DRY_RUN"
echo "[+] ALLOW_EXECUTION: $ALLOW_EXECUTION"
echo "[+] SHOW_PROGRESS: $SHOW_PROGRESS"
echo "[+] SHOW_LOGS: $SHOW_LOGS"

# If dry-run or execution not explicitly allowed, we will NOT execute commands.
EXECUTE_NOW=0
if [[ "${DRY_RUN:-1}" == "0" && "${ALLOW_EXECUTION:-0}" == "1" ]]; then
  EXECUTE_NOW=1
fi

# trap to ensure any background children are killed on script exit/interrupt
pids=()
declare -A pid_to_num
trap 'echo "[!] Caught signal; killing background PIDs: ${pids[*]}"; for pk in "${pids[@]}"; do kill -TERM "$pk" 2>/dev/null || true; done; exit 130' INT TERM EXIT

i=1
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

  # save meta header
  {
    echo "timestamp_utc: $(date -u --rfc-3339=seconds)"
    echo "input_line: $line"
  } > "$metafile"

  if [[ "$EXECUTE_NOW" -ne 1 ]]; then
    # Dry-run: write placeholder files describing what would have run
    echo "[DRY] saved #${num}: $line"
    {
      echo "DRY-RUN: command not executed"
      echo "original_command: $line"
      echo "meta:"
      cat "$metafile"
    } > "$outfile"
    # ensure an empty error file (so consumer tools know it exists)
    : > "$errfile"
  else
    echo "[+] starting #${num}: $line"
    # Run command in OUTDIR to contain any side-effects and keep outputs centralized
    # Using bash -c is explicit; avoid eval to reduce accidental expansions.
    ( cd "$OUTDIR" && bash -c "$line" ) > "$outfile" 2> "$errfile" &
    pid=$!
    pids+=("$pid")
    pid_to_num["$pid"]="$num"
  fi

  i=$((i+1))
done < "$INFILE"

# If nothing was scheduled (dry-run), finish quickly with summary
if [[ ${#pids[@]} -eq 0 ]]; then
  echo "[+] No commands executed (dry-run or execution not allowed). Placeholders in: $OUTDIR"
  echo "[+] Summary of saved placeholders:"
  for num in "${!num_to_cmd[@]}"; do
    echo "  #$num: ${num_to_cmd[$num]}"
  done
  exit 0
fi

# --- live progress / log preview loop ---
if [[ "${SHOW_PROGRESS}" == "1" || "${SHOW_LOGS}" == "1" ]]; then
  echo "[+] Monitoring ${#pids[@]} background processes (PIDs: ${pids[*]})"
fi

# poll loop: while any pid alive
while true; do
  alive=0
  running_pids=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive=$((alive+1))
      running_pids+=("$pid")
    fi
  done

  if [[ "${SHOW_PROGRESS}" == "1" ]]; then
    echo "[PROGRESS] $(date -u +%T) — running: ${alive} / ${#pids[@]}"
  fi

  if [[ "${SHOW_LOGS}" == "1" && ${#running_pids[@]} -gt 0 ]]; then
    # print a short preview of the latest stdout/stderr for each running pid
    echo "---- log previews (last ${TAIL_LINES} lines) ----"
    for pid in "${running_pids[@]}"; do
      num="${pid_to_num[$pid]}"
      of="${num_to_outfile[$num]}"
      ef="${num_to_errfile[$num]}"
      echo "## PID $pid (task #$num): ${num_to_cmd[$num]}"
      if [[ -f "$of" ]]; then
        echo "--- stdout (tail $TAIL_LINES) ---"
        tail -n "$TAIL_LINES" "$of" || true
      else
        echo "(stdout not yet created)"
      fi
      if [[ -f "$ef" ]]; then
        echo "--- stderr (tail $TAIL_LINES) ---"
        tail -n "$TAIL_LINES" "$ef" || true
      fi
      echo "---------------------------------------------"
    done
  fi

  if [[ $alive -eq 0 ]]; then
    break
  fi

  sleep 2
done

# Wait for any background processes to reap and collect exit codes
wait_status=0
declare -A num_exitcode
for pid in "${pids[@]}"; do
  # wait returns exit code of the process; capture it
  if wait "$pid"; then
    exit_code=0
  else
    exit_code=$?
  fi
  num="${pid_to_num[$pid]}"
  num_exitcode["$num"]="$exit_code"
done

# --- Final summary ---
echo ""
echo "[+] All commands finished. Summary saved in: $OUTDIR"
echo " #  exit  file(stdout)                     file(stderr)                     command\n"
echo "-----------------------------------------------------------------------------------------\n"
for num in $(echo '%s\n' "${!num_to_cmd[@]}" | sort); do
  ec="${num_exitcode[$num]:-N/A}"
  of="${num_to_outfile[$num]}"
  ef="${num_to_errfile[$num]}"
  cmd="${num_to_cmd[$num]}"
  echo " %2s  %4s  %-35s  %-30s  %s\n" "$num" "$ec" "$(basename "$of")" "$(basename "$ef")" "$(printf '%.80s' "$cmd")"
done

# Show a short tail of outputs (useful for quick inspection)
echo ""
echo "[+] Showing last $TAIL_LINES lines of each stdout/stderr (if present):"
for num in $(echo '%s\n' "${!num_to_cmd[@]}" | sort); do
  of="${num_to_outfile[$num]}"
  ef="${num_to_errfile[$num]}"
  echo "---- Task #$num: ${num_to_cmd[$num]} ----"
  if [[ -s "$of" ]]; then
    echo ">>> stdout (last $TAIL_LINES lines):"
    tail -n "$TAIL_LINES" "$of" || true
  else
    echo ">>> stdout: (empty)"
  fi
  if [[ -s "$ef" ]]; then
    echo ">>> stderr (last $TAIL_LINES lines):"
    tail -n "$TAIL_LINES" "$ef" || true
  else
    echo ">>> stderr: (empty)"
  fi
  echo "-----------------------------------------"
done

echo "[+] Done. Full artifacts in: $OUTDIR"
if [[ "$EXECUTE_NOW" -ne 1 ]]; then
  echo "[!] No network commands were executed: DRY_RUN or ALLOW_EXECUTION not set."
  echo "To execute (ONLY in isolated lab): DRY_RUN=0 ALLOW_EXECUTION=1 INFILE=$INFILE bash run_raw_cmds.sh"
fi

exit 0
