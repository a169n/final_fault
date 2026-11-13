#!/bin/bash
# Start one PostgreSQL node. Both nodes run this script, so either can end up as primary or standby.
#   node.sh <primary|standby> <peer-host>
# The first argument is only the role at first initialisation. Afterwards the data directory decides:
#   - empty directory, role standby          -> clone the peer (pg_basebackup -R) and start as standby
#   - empty directory, role primary          -> initdb (image entrypoint + init scripts), unless the
#                                               peer is already a primary: then clone it (rejoin)
#   - existing primary, peer is a primary on
#     a HIGHER timeline                      -> this node was failed over while it was down. Its data
#                                               is stale: discard it and clone the peer (rejoin as standby)
#   - anything else                          -> start with the data as it is
# The rejoin never triggers in baseline, midterm or endterm: nothing promotes the standby there.
set -uo pipefail

ROLE=${1:?role}
PEER=${2:?peer host}
DATA=/var/lib/postgresql/data
OPTS=(-c hba_file=/etc/postgresql/pg_hba.conf -c wal_level=replica -c max_wal_senders=10
      -c max_replication_slots=10 -c hot_standby=on)

say() { echo "node.sh: $*"; }

# The peer's timeline if it is up and a primary; empty otherwise.
peer_timeline() {
  PGPASSWORD=$REPL_PASSWORD PGCONNECT_TIMEOUT=2 psql -h "$PEER" -U repl -d university -tAc \
    "select case when pg_is_in_recovery() then '' else ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int::text end" \
    2>/dev/null | tr -d '[:space:]'
}

my_timeline() {
  gosu postgres pg_controldata "$DATA" | awk -F: "/Latest checkpoint's TimeLineID/ { gsub(/ /, \"\", \$2); print \$2 }"
}

clone_peer() {
  find "$DATA" -mindepth 1 -delete
  chown postgres:postgres "$DATA"
  until gosu postgres env PGPASSWORD="$REPL_PASSWORD" pg_basebackup -h "$PEER" -U repl -D "$DATA" -Fp -Xs -R; do
    say "peer $PEER not ready for pg_basebackup, retrying"
    find "$DATA" -mindepth 1 -delete
    sleep 2
  done
  say "cloned $PEER, starting as standby"
}

if [ -s "$DATA/PG_VERSION" ]; then
  if [ ! -f "$DATA/standby.signal" ]; then
    peer_tl=$(peer_timeline)
    if [ -n "$peer_tl" ] && [ "$peer_tl" -gt "$(my_timeline)" ]; then
      say "stale primary (timeline $(my_timeline), peer $PEER is primary on timeline $peer_tl): rejoining as standby"
      clone_peer
    fi
  fi
elif [ "$ROLE" = standby ]; then
  clone_peer
elif [ -n "$(peer_timeline)" ]; then
  say "empty data directory and $PEER is already a primary: rejoining as standby"
  clone_peer
fi

if [ -s "$DATA/PG_VERSION" ]; then
  chown -R postgres:postgres "$DATA"
  chmod 700 "$DATA"
fi
exec docker-entrypoint.sh postgres "${OPTS[@]}"
