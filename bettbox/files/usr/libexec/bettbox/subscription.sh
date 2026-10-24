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
	[ -n "$url" ] || { log "subscription $sid has no url"; return 1; }
	[ -f "$(profile_file "$sid")" ] || touch "$(profile_file "$sid")"

	ua=$(uci_get "bettbox.$sid.user_agent")
	[ -n "$ua" ] || ua="$DEFAULT_UA"

	tmp="$BETTBOX_STATE/$sid.dl"
	hdr="$BETTBOX_STATE/$sid.hdr"
	mkdir -p "$BETTBOX_STATE"

	# file:// profiles are read directly (curl 8 rejects bare-path URLs).
	if [ "${url#file://}" != "$url" ]; then
		if ! cat "${url#file://}" > "$tmp" 2>/dev/null; then
			rm -f "$tmp"
			log "subscription $sid local profile unreadable: $url"
			return 1
		fi
		: > "$hdr"
	elif ! curl -sSL --fail -m 90 -A "$ua" -D "$hdr" -o "$tmp" "$url"; then
		rm -f "$tmp" "$hdr"
		log "subscription $sid download failed"
		return 1
	fi

	# age-encrypted subscription (Bettbox parity): armor and raw formats share
	# the "age-encryption.org" magic in the first bytes.
	if head -c 80 "$tmp" | grep -q 'age-encryption.org'; then
		local ident idf dec
		ident=$(uci_get "bettbox.$sid.age_identity")
		[ -n "$ident" ] || ident=$(uci_get bettbox.config.age_identity)
		[ -n "$ident" ] || { rm -f "$tmp" "$hdr"; log "subscription $sid is age-encrypted but no age_identity configured"; return 1; }
		command -v age >/dev/null || { rm -f "$tmp" "$hdr"; log "age not installed (apk add age)"; return 1; }
		idf="$BETTBOX_STATE/$sid.agekey"
		dec="$BETTBOX_STATE/$sid.dec"
		printf '%s\n' "$ident" > "$idf"
		chmod 600 "$idf"
		if ! age -d -i "$idf" -o "$dec" "$tmp"; then
			rm -f "$idf" "$dec" "$tmp" "$hdr"
			log "subscription $sid age decryption failed"
			return 1
		fi
		rm -f "$idf" "$tmp"
		tmp="$dec"
		log "subscription $sid age-decrypted"
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
		sleep 1
		sid="sub$(date +%s)"
	done
	uci set "bettbox.$sid=subscription"
	uci set "bettbox.$sid.url=$url"
	uci set "bettbox.$sid.label=${2:-$sid}"
	uci set "bettbox.$sid.auto_update=1"
	uci set "bettbox.$sid.update_interval=1440"
	uci set "bettbox.$sid.use_script=0"
	uci set "bettbox.$sid.custom_options={}"
	uci commit bettbox
	if ! update_one "$sid"; then
		uci -q delete "bettbox.$sid"
		uci commit bettbox
		echo "subscription download failed, not added" >&2
		return 1
	fi
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
