#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Backup / restore: UCI config + profiles + scripts + rules.
# Optional WebDAV upload (Bettbox WebDAV backup parity): push/pull/list.

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

# ---------- WebDAV ----------

dav_curl() {
	# dav_curl <curl args...>
	local user pass
	user=$(uci_get bettbox.backup.username)
	pass=$(uci_get bettbox.backup.password)
	if [ -n "$user" ]; then
		curl -sS --user "$user:$pass" "$@"
	else
		curl -sS "$@"
	fi
}

dav_url() {
	local u
	u=$(uci_get bettbox.backup.url)
	[ -n "$u" ] || die "webdav not configured (uci set bettbox.backup.url='https://dav.example.com/bettbox/')"
	case "$u" in
	*/) ;;
	*) u="$u/" ;;
	esac
	echo "$u"
}

dav_file() {
	local f
	f=$(uci_get bettbox.backup.filename)
	[ -n "$f" ] || f="bettbox-backup.tar"
	echo "$(dav_url)$f"
}

push() {
	local f="/tmp/bettbox-backup.$$" code
	create "$f" || die "create backup failed"
	code=$(dav_curl -o /dev/null -w '%{http_code}' -T "$f" "$(dav_file)" 2>/dev/null)
	rm -f "$f"
	case "$code" in
		200|201|204)
			log "backup pushed to webdav (HTTP $code)"
			echo "ok: HTTP $code"
			;;
		*)
			die "webdav upload failed (HTTP ${code:-none})"
			;;
	esac
}

pull() {
	local f="/tmp/bettbox-restore.$$" code
	code=$(dav_curl -o "$f" -w '%{http_code}' "$(dav_file)" 2>/dev/null)
	[ "$code" = "200" ] || { rm -f "$f"; die "webdav download failed (HTTP ${code:-none})"; }
	restore "$f"
	rm -f "$f"
}

list() {
	local out
	out=$(dav_curl -X PROPFIND -H "Depth: 1" "$(dav_url)" 2>/dev/null) || die "webdav PROPFIND failed"
	[ -n "$out" ] || die "webdav PROPFIND failed"
	printf '%s\n' "$out" | grep -oE '<[Dd]:href>[^<]*</[Dd]:href>|<href>[^<]*</href>' | sed -E 's/<[^>]*>//g'
}

case "$1" in
create)
	create "$2"
	;;
restore)
	restore "$2"
	;;
push)
	push
	;;
pull)
	pull
	;;
list)
	list
	;;
*)
	die "usage: backup.sh create|restore|push|pull|list ..."
	;;
esac
