#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Backup / restore: UCI config + profiles + scripts + rules.
# Optional WebDAV upload (Bettbox WebDAV backup parity): push/pull/list.

. /usr/libexec/bettbox/common.sh
umask 077

create() {
	[ -n "$1" ] || die "usage: backup.sh create <file.tar>"
	tar -C / -cf "$1" \
		etc/config/bettbox \
		etc/bettbox/profiles \
		etc/bettbox/scripts \
		etc/bettbox/rules \
		2>/dev/null || die "backup failed"
	chmod 600 "$1" || die "could not secure backup permissions"
	log "backup written to $1"
}

restore() (
	[ -n "$1" ] || die "usage: backup.sh restore <file.tar>"
	local stage entry rc
	stage=$(mktemp -d /tmp/bettbox-restore.XXXXXX) || die "could not create restore workspace"
	trap "rm -rf '$stage'" EXIT
	tar -tf "$1" > "$stage/list" || die "invalid backup archive"
	[ -s "$stage/list" ] || die "empty backup archive"
	while IFS= read -r entry; do
		case "$entry" in
			etc/config/bettbox|etc/bettbox/profiles/|etc/bettbox/profiles/*|etc/bettbox/scripts/|etc/bettbox/scripts/*|etc/bettbox/rules/|etc/bettbox/rules/*) ;;
			*) die "backup contains an unexpected path" ;;
		esac
		case "/$entry/" in *'/../'*|*'/./'*|*'//'*) die "backup contains an unsafe path" ;; esac
	done < "$stage/list"
	# Links and special files must never redirect extraction outside the stage.
	tar -tvf "$1" > "$stage/types" || die "invalid backup archive"
	awk 'substr($0,1,1) != "-" && substr($0,1,1) != "d" { exit 1 }' "$stage/types" || die "backup contains links or special files"
	tar -C "$stage" -xf "$1" || die "restore extraction failed"
	[ -f "$stage/etc/config/bettbox" ] || die "backup has no Bettbox configuration"
	uci -c "$stage/etc/config" show bettbox >/dev/null 2>&1 || die "backup contains invalid UCI configuration"
	[ -z "$(uci -q changes bettbox)" ] || die "save or discard pending Bettbox changes before restore"
	cp -p "$stage/etc/config/bettbox" /etc/config/bettbox || die "restore configuration failed"
	chmod 600 /etc/config/bettbox || die "could not secure restored configuration"
	local directory
	for directory in profiles scripts rules; do
		if [ -d "$stage/etc/bettbox/$directory" ]; then
			[ ! -L "$BETTBOX_ETC/$directory" ] || die "restore target must not be a symbolic link"
			mkdir -p "$BETTBOX_ETC/$directory" || die "restore directory failed"
			cp -R "$stage/etc/bettbox/$directory/." "$BETTBOX_ETC/$directory/" || die "restore files failed"
		fi
	done
	sh /usr/libexec/bettbox/router-settings.sh || die "restore settings migration failed"
	/usr/bin/bettbox apply-service || die "restored configuration could not be applied"
	log "restored from $1"
)

# ---------- WebDAV ----------

dav_curl() {
	# dav_curl <curl args...>
	local user pass
	user=$(uci_get bettbox.backup.username)
	pass=$(uci_get bettbox.backup.password)
	if [ -n "$user" ]; then
		curl -fsS --connect-timeout 10 -m 120 --user "$user:$pass" "$@"
	else
		curl -fsS --connect-timeout 10 -m 120 "$@"
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
	local f code
	f=$(mktemp /tmp/bettbox-backup.XXXXXX) || die "could not create backup workspace"
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
	local f code rc
	f=$(mktemp /tmp/bettbox-restore.XXXXXX) || die "could not create restore workspace"
	code=$(dav_curl -o "$f" -w '%{http_code}' "$(dav_file)" 2>/dev/null)
	[ "$code" = "200" ] || { rm -f "$f"; die "webdav download failed (HTTP ${code:-none})"; }
	restore "$f"
	rc=$?
	rm -f "$f"
	return "$rc"
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
