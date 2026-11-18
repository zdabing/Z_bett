#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Keep the subscription auto-update cron line in /etc/crontabs/root.

. /usr/libexec/bettbox/common.sh

CRON_LINE="*/10 * * * * /usr/bin/bettbox cron"
LEGACY_CRON_LINE="*/10 * * * * /usr/bin/bettbox subscription cron"
CRONTAB=/etc/crontabs/root

rewrite() {
	local action="$1" tmp rc
	[ "$action" = remove ] && [ ! -f "$CRONTAB" ] && return 0
	mkdir -p "$(dirname "$CRONTAB")" || return 1
	tmp=$(mktemp "$CRONTAB.XXXXXX") || return 1
	if [ -f "$CRONTAB" ]; then
		grep -vFx -e "$CRON_LINE" -e "$LEGACY_CRON_LINE" "$CRONTAB" > "$tmp"
		rc=$?
		# grep returns 1 when removing the last remaining entry; that is valid.
		if [ "$rc" -gt 1 ]; then
			rm -f "$tmp"
			return 1
		fi
	fi
	if [ "$action" = ensure ]; then
		printf '%s\n' "$CRON_LINE" >> "$tmp" || { rm -f "$tmp"; return 1; }
	fi
	if cmp -s "$tmp" "$CRONTAB"; then
		rm -f "$tmp"
		return 0
	fi
	mv -f "$tmp" "$CRONTAB" || { rm -f "$tmp"; return 1; }
	/etc/init.d/cron restart 2>/dev/null
}

has_auto_subscriptions() {
	local sid
	for sid in $(uci -q show bettbox | sed -n "s/^bettbox\.\([^.]*\)\.auto_update='1'/\1/p"); do
		[ -n "$(uci_get "bettbox.$sid.url")" ] && return 0
	done
	return 1
}

ensure() {
	if [ "$(uci_get bettbox.config.enabled)" = "1" ] && has_auto_subscriptions; then
		rewrite ensure
	else
		rewrite remove
	fi
}

remove() {
	rewrite remove
}

case "$1" in
ensure)
	ensure
	;;
remove)
	remove
	;;
*)
	die "usage: cron.sh ensure|remove"
	;;
esac
