#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Backup / restore: UCI config + profiles + scripts + rules.

. /usr/libexec/bettbox/common.sh

create() {
	[ -n "$1" ] || die "usage: backup.sh create <file.tar>"
	tar -C / -cf "$1" \
		etc/config/bettbox \
		etc/bettbox/profiles \
		etc/bettbox/scripts \
		etc/bettbox/rules \
		2>/dev/null || die "backup failed"
	log "backup written to $1"
}

restore() {
	[ -n "$1" ] || die "usage: backup.sh restore <file.tar>"
	tar -C / -xf "$1" || die "restore failed"
	uci commit bettbox 2>/dev/null
	/usr/libexec/bettbox/apply.sh live || true
	log "restored from $1"
}

case "$1" in
create)
	create "$2"
	;;
restore)
	restore "$2"
	;;
*)
	die "usage: backup.sh create|restore <file.tar>"
	;;
esac
