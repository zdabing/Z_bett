#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# procd watchdog instance: controller health check + config presence.

. /usr/libexec/bettbox/common.sh

seconds_value() {
	local value=$1 fallback=$2
	case "$value" in ''|*[!0-9]*) value=$fallback ;; esac
	# Shell arithmetic treats a leading zero as octal. UCI values are decimal.
	while [ "${value#0}" != "$value" ]; do value=${value#0}; done
	[ -n "$value" ] || value=0
	[ "${#value}" -le 6 ] || value=$fallback
	printf '%s' "$value"
}

interval() {
	local i
	i=$(seconds_value "$(uci_get bettbox.config.watchdog_interval)" 30)
	[ "$i" -gt 0 ] || i=30
	echo "$i"
}

can_check() {
	[ "$(uci_get bettbox.config.watchdog)" = 1 ] &&
	[ "$(uci_get bettbox.config.enabled)" = 1 ] &&
	[ -f "$BETTBOX_RUN/ready" ] && [ ! -d /var/run/bettbox-service.lock ]
}

healthy() {
	local endpoint secret data
	[ -f "$BETTBOX_RUN/config.yaml" ] || return 1
	# Saved UCI settings may not yet be applied. Probe the running snapshot.
	endpoint=$(yq -r '."external-controller" // ""' "$BETTBOX_RUN/config.yaml" 2>/dev/null)
	secret=$(yq -r '.secret // ""' "$BETTBOX_RUN/config.yaml" 2>/dev/null)
	case "$endpoint" in 0.0.0.0:*) endpoint="127.0.0.1:${endpoint##*:}" ;; '[::]':*) endpoint="[::1]:${endpoint##*:}" ;; esac
	[ -n "$endpoint" ] || return 1
	data=$(curl -fsS --noproxy '*' --connect-timeout 1 --max-time 2 -H "Authorization: Bearer $secret" "http://$endpoint/version" 2>/dev/null) || return 1
	printf '%s' "$data" | yq -e '.version != null' >/dev/null 2>&1
}

fails=0
elapsed=0
deep_elapsed=3600
last_issue=''
uptime_seconds() { local seconds rest; read -r seconds rest < /proc/uptime; printf '%s' "${seconds%.*}"; }
while :; do
	wait=$(interval)
	case "$(uci_get bettbox.config.device_mode):$(uci_get bettbox.config.transparent_mode)" in
	include:tun|exclude:tun) [ "$wait" -le 5 ] || wait=5 ;;
	esac
	sleep "$wait"
	if [ -f "$BETTBOX_RUN/device-tun" ]; then
		/usr/libexec/bettbox/firewall.sh repair || log "device route recovery failed; will retry"
	fi
	# Route repair is also needed when health-based restarts are disabled.
	if ! can_check; then fails=0; elapsed=0; continue; fi
	elapsed=$((elapsed + wait))
	[ "$elapsed" -ge "$(interval)" ] || continue
	cycle_elapsed=$elapsed
	elapsed=0
	if healthy; then
		fails=0
		deep_elapsed=$((deep_elapsed + cycle_elapsed))
		deep_interval=$(seconds_value "$(uci_get bettbox.config.health_interval)" 300)
		if [ "$deep_interval" -gt 0 ]; then
			[ "$deep_interval" -ge 60 ] || deep_interval=60
			if [ "$deep_elapsed" -ge "$deep_interval" ]; then
				deep_elapsed=0
				if timeout 20 sh /usr/libexec/bettbox/health-check.sh www.baidu.com --record >/dev/null 2>&1; then
					issue=$(yq -r '.summary.issue // "unknown"' "$BETTBOX_RUN/health.json" 2>/dev/null)
					if [ -n "$issue" ] && [ "$issue" != "$last_issue" ]; then
						[ "$issue" = none ] || log "health: $issue (diagnostic only; no network changes)"
						last_issue=$issue
					fi
				fi
			fi
		fi
	else
		fails=$((fails + 1))
		log "watchdog: core unhealthy ($fails/2)"
		if [ "$fails" -ge 2 ]; then
			fails=0
			# A user stop/apply may have begun during the controller timeout.
			can_check || continue
			now=$(uptime_seconds)
			previous=$(cat "$BETTBOX_RUN/watchdog-last-restart" 2>/dev/null)
			case "$previous" in ''|*[!0-9]*) previous=-300 ;; esac
			if [ "$now" -ge "$previous" ] && [ $((now-previous)) -lt 300 ]; then
				log "watchdog: restart cooldown; keeping current network state"
				continue
			fi
			printf '%s' "$now" > "$BETTBOX_RUN/watchdog-last-restart"
			log "watchdog: restarting bettbox"
			/etc/init.d/bettbox restart 2>/dev/null || true
		fi
	fi
done
