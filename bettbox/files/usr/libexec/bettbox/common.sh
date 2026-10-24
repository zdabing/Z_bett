#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Shared helpers (sourced).

BETTBOX_RUN=/var/run/bettbox
BETTBOX_ETC=/etc/bettbox
BETTBOX_PROFILES=$BETTBOX_ETC/profiles
BETTBOX_SCRIPTS=$BETTBOX_ETC/scripts
BETTBOX_STATE=$BETTBOX_ETC/state

log() {
	logger -t bettbox "$*"
}

die() {
	log "$*"
	echo "$*" >&2
	exit 1
}

uci_get() {
	uci -q get "$1"
}

# Controller endpoint for REST calls (always loopback from the box itself).
api_host_port() {
	local hc
	hc=$(uci_get bettbox.config.external_controller)
	[ -n "$hc" ] || hc="127.0.0.1:9097"
	local host="${hc%%:*}"
	local port="${hc##*:}"
	echo "127.0.0.1:${port}"
}

api_secret() {
	uci_get bettbox.config.secret
}

api_call() {
	# api_call <METHOD> <PATH> [JSON_BODY] -> response body on stdout
	local method="${1:-GET}"
	local path="$2"
	local body="$3"
	local hp secret
	hp=$(api_host_port)
	secret=$(api_secret)
	if [ -n "$body" ]; then
		curl -sS -m 8 -X "$method" \
			-H "Authorization: Bearer $secret" \
			-H "Content-Type: application/json" \
			-d "$body" \
			"http://${hp}${path}"
	else
		curl -sS -m 8 -X "$method" \
			-H "Authorization: Bearer $secret" \
			"http://${hp}${path}"
	fi
}

# Escape a string into a JSON literal (ucode based). json() only parses on
# some ucode builds; serialization goes through sprintf %J.
json_str() {
	printf '%s' "$1" | ucode -e 'import { readfile } from "fs"; print(sprintf("%J", json(readfile("/dev/stdin"))))'
}

profile_file() {
	echo "$BETTBOX_PROFILES/$1.yaml"
}
