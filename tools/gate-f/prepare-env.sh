#!/usr/bin/env bash
# Gate F: write the private environment file for the one owner-authorized run.
#
#   bash tools/gate-f/prepare-env.sh            (asks three questions)
#
# It generates the dashboard password and the two secrets, writes ./gate-f.env
# (mode 600, never overwritten), and prints the two commands that start the
# qualified container on this computer. Nothing is sent anywhere.
#
# Keep gate-f.env in your password manager afterwards: H2G_CREDENTIALS_KEY
# seals the Garmin tokens and the Hevy key in the gate F database and is
# needed again at gate G. Never commit it.
#
# Non-interactive (tests): GATE_F_DATABASE_URL, GATE_F_HEVY_ID,
# GATE_F_GARMIN_ACTIVITY_ID, GATE_F_DAYS, GATE_F_OUT.
set -euo pipefail
umask 077

out="${GATE_F_OUT:-gate-f.env}"
if [ -e "$out" ]; then
  echo "refusing: $out already exists (delete it first if you really want a new authorization)" >&2
  exit 1
fi
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

ask() { # ask VAR "prompt" [silent]
  local var="$1" prompt="$2" silent="${3:-}" value="${!1:-}"
  if [ -z "$value" ]; then
    if [ -n "$silent" ]; then read -r -s -p "$prompt" value; echo >&2; else read -r -p "$prompt" value; fi
  fi
  printf -v "$var" '%s' "$value"
}

ask GATE_F_DATABASE_URL "Connection string of the NEW, empty Neon database (postgresql://…): " silent
ask GATE_F_HEVY_ID "Hevy workout id (from the workout's URL): "
ask GATE_F_GARMIN_ACTIVITY_ID "Garmin activity id (connect.garmin.com/modern/activity/<id>): "
days="${GATE_F_DAYS:-3}"

case "$GATE_F_DATABASE_URL" in postgres://*|postgresql://*) ;; *) echo "refusing: not a Postgres connection string" >&2; exit 1 ;; esac
[[ "$GATE_F_HEVY_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || { echo "refusing: not a Hevy workout id" >&2; exit 1; }
[[ "$GATE_F_HEVY_ID" == syn-* ]] && { echo "refusing: syn-… ids belong to the synthetic staging" >&2; exit 1; }
[[ "$GATE_F_GARMIN_ACTIVITY_ID" =~ ^[1-9][0-9]{0,15}$ ]] || { echo "refusing: not a Garmin activity id" >&2; exit 1; }
[[ "$days" =~ ^([1-9]|1[0-4])$ ]] || { echo "refusing: GATE_F_DAYS must be 1-14" >&2; exit 1; }

# GNU date, then BSD/macOS date.
expires=$(date -u -d "+${days} days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+"${days}"d +%Y-%m-%dT%H:%M:%SZ)
password=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)

cat > "$out" <<ENV
# Gate F: ONE owner-authorized activity. Private: keep in your password manager, never commit.
DATABASE_URL=$GATE_F_DATABASE_URL
H2G_PASSWORD=$password
HEVY2GARMIN_SECRET=$(openssl rand -hex 32)
H2G_CREDENTIALS_KEY=$(openssl rand -base64 32)
H2G_DIRECT_GARMIN_LOGIN=1
H2G_UPDATE_CHECK=off
H2G_GATE_F=approved-by-owner
H2G_GATE_F_HEVY_ID=$GATE_F_HEVY_ID
H2G_GATE_F_GARMIN_ACTIVITY_ID=$GATE_F_GARMIN_ACTIVITY_ID
H2G_GATE_F_EXPIRES=$expires
ENV
chmod 600 "$out"

echo "Wrote $out (valid until $expires)."
echo "Dashboard password (also in the file): $password"
echo
echo "Start the qualified container from this checkout:"
echo "  docker build -f web/Dockerfile -t hevy2garmin-gate-f ."
echo "  docker run --rm -p 127.0.0.1:8096:8096 --env-file $out hevy2garmin-gate-f"
echo "Then open http://localhost:8096 and follow docs/OWNER_RUNBOOK.md."
