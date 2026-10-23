#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Keep the subscription auto-update cron line in /etc/crontabs/root.

. /usr/libexec/bettbox/common.sh

CRON_LINE="*/10 * * * * /usr/bin/bettbox subscription cron"
CRONTAB=/etc/crontabs/root

ensure() {
	[ -f "$CRONTAB" ] && grep -qF "$CRON_LINE" "$CRONTAB" && return 0
	mkdir -p /etc/crontabs
	touch "$CRONTAB"
	echo "$CRON_LINE" >> "$CRONTAB"
	/etc/init.d/cron restart 2>/dev/null || true
}

remove() {
	grep -vF "$CRON_LINE" "$CRONTAB" > "$CRONTAB.tmp" 2>/dev/null && mv "$CRONTAB.tmp" "$CRONTAB"
	/etc/init.d/cron restart 2>/dev/null || true
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
