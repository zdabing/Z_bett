#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# procd watchdog instance: controller health check + config presence.

. /usr/libexec/bettbox/common.sh

interval() {
	local i
	i=$(uci_get bettbox.config.watchdog_interval)
	[ -n "$i" ] || i=30
	echo "$i"
}

healthy() {
	[ -f "$BETTBOX_RUN/config.yaml" ] || return 1
	api_call GET /version | grep -q version
}

fails=0
while :; do
	sleep "$(interval)"
	if healthy; then
		fails=0
	else
		fails=$((fails + 1))
		log "watchdog: core unhealthy ($fails/2)"
		if [ "$fails" -ge 2 ]; then
			fails=0
			log "watchdog: restarting bettbox"
			/etc/init.d/bettbox restart 2>/dev/null || true
		fi
	fi
done
