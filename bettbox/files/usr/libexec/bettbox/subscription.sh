#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Subscription management: fetch/validate/store profiles, auto-update cron.

. /usr/libexec/bettbox/common.sh

DEFAULT_UA="clash.meta/v1.19.33"
NOW=$(date +%s)

# parse "upload=1; download=2; total=3; expire=4" from raw header line
set_userinfo() {
	# $1 sid, $2 header value
	local upload download total expire
	upload=$(echo "$2" | tr ';' '\n' | sed -n 's/^upload=//p' | head -1)
	download=$(echo "$2" | tr ';' '\n' | sed -n 's/^download=//p' | head -1)
	total=$(echo "$2" | tr ';' '\n' | sed -n 's/^total=//p' | head -1)
	expire=$(echo "$2" | tr ';' '\n' | sed -n 's/^expire=//p' | head -1)
	uci -q set "bettbox.$sid.sub_upload=${upload:-0}"
	uci -q set "bettbox.$sid.sub_download=${download:-0}"
	uci -q set "bettbox.$sid.sub_total=${total:-0}"
	uci -q set "bettbox.$sid.sub_expire=${expire:-0}"
}

update_one() {
	# $1 = uci section id
	sid="$1"
	local url ua tmp hdr n
	url=$(uci_get "bettbox.$sid.url")
	[ -n "$url" ] && { [ "${url#file://}" = "$url" ] || url="${url#file://}"; }
	[ -n "$url" ] || { log "subscription $sid has no url"; return 1; }
	[ -f "$(profile_file "$sid")" ] || touch "$(profile_file "$sid")"

	ua=$(uci_get "bettbox.$sid.user_agent")
	[ -n "$ua" ] || ua="$DEFAULT_UA"

	tmp="$BETTBOX_STATE/$sid.dl"
	hdr="$BETTBOX_STATE/$sid.hdr"
	mkdir -p "$BETTBOX_STATE"

	if ! curl -sSL --fail -m 90 -A "$ua" -D "$hdr" -o "$tmp" "$url"; then
		rm -f "$tmp" "$hdr"
		log "subscription $sid download failed"
		return 1
	fi

	# must be a mihomo YAML with proxies (Bettbox treats subs as raw YAML)
	if [ "$(yq '.proxies | length > 0' "$tmp" 2>/dev/null)" != "true" ]; then
		rm -f "$tmp" "$hdr"
		log "subscription $sid has no proxies, keeping old profile"
		return 1
	fi

	set_userinfo "$sid" "$(grep -i '^subscription-userinfo:' "$hdr" | head -1 | sed 's/^[Ss]ubscription-[Uu]ser[Ii]nfo: *//' | tr -d '\r')"
	rm -f "$hdr"

	mv -f "$tmp" "$(profile_file "$sid")"
	uci -q set "bettbox.$sid.last_update=$NOW"
	uci commit bettbox
	log "subscription $sid updated"

	if [ "$(uci_get bettbox.config.profile)" = "$sid" ] && [ "$(uci_get bettbox.config.enabled)" = "1" ]; then
		/usr/libexec/bettbox/apply.sh live
	fi
	return 0
}

update() {
	[ -n "$1" ] || die "usage: subscription.sh update <sid>"
	update_one "$1"
}

update_all() {
	local sid
	for sid in $(uci -q show bettbox | sed -n "s/^bettbox\.\([^.]*\)\.url=.*/\1/p"); do
		update_one "$sid" || true
		sleep 2
	done
}

# called from cron: refresh every auto_update subscription whose interval passed
cron() {
	local sid interval last
	for sid in $(uci -q show bettbox | sed -n "s/^bettbox\.\([^.]*\)\.auto_update='1'/\1/p"); do
		[ -n "$(uci_get bettbox.$sid.url)" ] || continue
		interval=$(uci_get "bettbox.$sid.update_interval")
		[ -n "$interval" ] || interval=1440
		last=$(uci_get "bettbox.$sid.last_update")
		[ -n "$last" ] || last=0
		if [ $((NOW - last)) -gt $((interval * 60)) ]; then
			update_one "$sid" || true
			sleep 2
		fi
	done
}

add() {
	# add <url> [label]
	local url="$1"
	[ -n "$url" ] || die "usage: subscription.sh add <url> [label]"
	local sid
	sid="sub$(date +%s)"
	while uci -q get "bettbox.$sid" >/dev/null; do
		sid="sub$(date +%s)$RANDOM"
	done
	uci set "bettbox.$sid=subscription"
	uci set "bettbox.$sid.url=$url"
	uci set "bettbox.$sid.label=${2:-$sid}"
	uci set "bettbox.$sid.auto_update=1"
	uci set "bettbox.$sid.update_interval=1440"
	uci set "bettbox.$sid.use_script=0"
	uci set "bettbox.$sid.custom_options={}"
	uci commit bettbox
	update_one "$sid"
	echo "$sid"
}

remove() {
	[ -n "$1" ] || die "usage: subscription.sh remove <sid>"
	uci -q delete "bettbox.$1"
	uci commit bettbox
	rm -f "$(profile_file "$1")"
}

case "$1" in
update)
	update "$2"
	;;
update-all)
	update_all
	;;
cron)
	cron
	;;
add)
	add "$2" "$3"
	;;
remove)
	remove "$2"
	;;
*)
	die "usage: subscription.sh update|update-all|cron|add|remove ..."
	;;
esac
