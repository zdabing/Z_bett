#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Render the active profile (+ UCI + JS overrides) into the runtime config.

. /usr/libexec/bettbox/common.sh
umask 077

apply() (
	# Each render owns its scratch files; a competing CLI request cannot replace
	# a candidate while it is being validated. Publish only the validated result.
	local work
	mkdir -p "$BETTBOX_RUN" "$BETTBOX_STATE" || return 1
	work=$(mktemp -d "$BETTBOX_RUN/render.XXXXXX") || return 1
	trap 'rm -rf "$work"' EXIT
	local sid
	sid=$(uci_get bettbox.config.profile)
	[ -n "$sid" ] || die "no profile selected (uci bettbox.config.profile)"

	local src
	src=$(profile_file "$sid")
	[ -f "$src" ] || die "profile file missing: $src"

	mkdir -p "$BETTBOX_RUN" "$BETTBOX_STATE"

	local base="$work/base.json"
	yq -o=json -I=0 '.' "$src" > "$base" || die "profile is not valid YAML"

	# JS override (Bettbox script contract) via bettbox-forge
	if [ "$(uci_get bettbox.$sid.use_script)" = "1" ]; then
		local script
		script=$(uci_get bettbox.$sid.script)
		local script_file="$BETTBOX_SCRIPTS/$script.js"
		if [ -f "$script_file" ] && command -v bettbox-forge >/dev/null; then
			local opts out="$work/scripted.json" err="$work/forge.err"
			opts=$(uci_get bettbox.$sid.custom_options)
			if timeout 60 bettbox-forge run --script "$script_file" --config "$base" \
				${opts:+--options "$opts"} --out "$out" 2> "$err"; then
				cp "$out" "$base"
			else
				log "override script failed, falling back to unscripted profile: $(cat "$err")"
			fi
			rm -f "$out" "$err"
		else
			log "override script '$script' not found, skipping"
		fi
	fi

	local out="$work/config.yaml" validation="$work/validation.log" core
	core=$(core_binary)
	if ! ucode /usr/libexec/bettbox/render.uc "$base" "$out" "$sid"; then
		rm -f "$out"
		die "config render failed"
	fi

	# validate; retry once with geodata-mode off (upstream patchValidateConfig)
	if ! timeout 120 "$core" -t -d "$BETTBOX_ETC" -f "$out" >"$validation" 2>&1; then
		if grep -q '^geodata-mode: true$' "$out"; then
			log "config validation failed, retrying with geodata-mode off"
			sed -i 's/^geodata-mode: true$/geodata-mode: false/' "$out"
			if timeout 120 "$core" -t -d "$BETTBOX_ETC" -f "$out" >"$validation" 2>&1; then
				mv -f "$out" "$BETTBOX_RUN/config.yaml"
				return $?
			fi
		fi
		tail -5 "$validation" >&2
		rm -f "$out"
		die "config validation failed"
	fi

	mv -f "$out" "$BETTBOX_RUN/config.yaml"
)

# Hot-apply through the controller API when the core is running, like
# Bettbox's updateConfig; falls back to a service restart.
apply_live() {
	apply || return 1
	if [ "$(uci_get bettbox.config.enabled)" != "1" ]; then
		/etc/init.d/bettbox stop
		return $?
	fi
	if [ -f "$BETTBOX_RUN/config.yaml" ] && api_call GET /version | grep -q version; then
		api_call PUT /configs "{\"path\": \"$BETTBOX_RUN/config.yaml\", \"payload\": \"\", \"force\": true}" >/dev/null || return 1
		return 0
	fi
	/etc/init.d/bettbox restart
}

apply_service() {
	# Settings can change inbound ports, DNS, routing, or the enabled flag.
	# A full service transition applies all of them, including stopping a core
	# when the user switches it off. start_service performs rendering once.
	if [ "$(uci_get bettbox.config.enabled)" = "1" ]; then
		/etc/init.d/bettbox enable && /etc/init.d/bettbox restart
	else
		/etc/init.d/bettbox stop
	fi
}

case "$1" in
apply)
	apply
	;;
live)
	apply_live
	;;
service)
	apply_service
	;;
*)
	die "usage: apply.sh apply|live|service"
	;;
esac
