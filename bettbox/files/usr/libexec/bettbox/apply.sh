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

	local managed is_managed=0 use_script active_nodes="$work/active-nodes.json" active_names="$work/active-node-names.json" has_nodes=0 names_arg=""
	managed=$(uci_get "bettbox.$sid.use_managed")
	use_script=$(uci_get "bettbox.$sid.use_script")
	if [ -n "$(uci_get "bettbox.$sid.merge_members")" ]; then
		managed=0
		[ "$use_script" = "1" ] || is_managed=1
	elif [ "$managed" = "1" ]; then
		is_managed=1
	fi
	if [ -s /etc/bettbox/nodes.json ]; then
		ucode /usr/libexec/bettbox/node-store.uc active-for "$sid" "$is_managed" > "$active_nodes" || printf '[]\n' > "$active_nodes"
		ucode /usr/libexec/bettbox/node-store.uc active-names "$sid" "$is_managed" > "$active_names" || printf '[]\n' > "$active_names"
		if [ "$(ucode -e 'import {readfile} from "fs"; let a=null; try{a=json(readfile(ARGV[0]));}catch(e){} print(type(a)=="array"&&length(a)>0?"1":"0");' "$active_nodes")" = "1" ]; then
			has_nodes=1
			names_arg="$active_names"
		fi
	fi
	# JS override (Bettbox script contract) via bettbox-forge
	if [ "$(uci_get bettbox.$sid.use_script)" = "1" ] || [ "$managed" = "1" ]; then
		local script
		script=$(uci_get bettbox.$sid.script)
		local script_file="$BETTBOX_SCRIPTS/$script.js"
		if [ "$managed" = "1" ]; then
			script_file="$work/managed.js"
			uci -q get "bettbox.$sid.managed_routing" > "$work/managed.json" || printf '{}\n' > "$work/managed.json"
			ucode /usr/libexec/bettbox/managed-routing.uc "$work/managed.json" "$script_file" ${names_arg:+"$names_arg"} || return 1
		fi
		if [ -f "$script_file" ] && command -v bettbox-forge >/dev/null; then
			local opts out="$work/scripted.json" err="$work/forge.err"
			opts=$(uci_get bettbox.$sid.custom_options)
			if [ "$managed" = "1" ]; then
				opts=$(uci_get "bettbox.$sid.managed_options")
			fi
			if timeout 60 bettbox-forge run --script "$script_file" --config "$base" \
				${opts:+--options "$opts"} --out "$out" 2> "$err"; then
				cp "$out" "$base"
			else
				[ "$managed" != "1" ] || die '托管分流脚本执行失败'
				log "override script failed, falling back to unscripted profile: $(cat "$err")"
			fi
			rm -f "$out" "$err"
		else
			[ "$managed" != "1" ] || die '缺少内置托管脚本或 Bettbox Forge'
			log "override script '$script' not found, skipping"
		fi
	fi

	local out="$work/config.yaml" validation="$work/validation.log" core
	core=$(core_binary)
	if ! ucode /usr/libexec/bettbox/render.uc "$base" "$out" "$sid" $([ "$has_nodes" = 1 ] && echo keep-markers) 2> "$work/render.log"; then
		cat "$work/render.log" >&2
		rm -f "$out"
		die "config render failed"
	fi
	if [ -s "$work/render.log" ]; then
		cat "$work/render.log" >&2
		while IFS= read -r message; do [ -z "$message" ] || log "$message"; done < "$work/render.log"
	fi

	if [ "$has_nodes" = 1 ]; then
		if ! timeout 20 /usr/bin/mihomo bettbox-patch-nodes "$out" "$active_nodes" "$out.patched"; then
			rm -f "$out" "$out.patched"
			die "node library patch failed"
		fi
		mv -f "$out.patched" "$out"
	fi

	if ! timeout 120 "$core" -t -d "$BETTBOX_ETC" -f "$out" >"$validation" 2>&1; then
		tail -5 "$validation" >&2
		rm -f "$out"
		die "config validation failed"
	fi

	if [ -f "$out.sig" ]; then
		if [ -f "$BETTBOX_RUN/fakeip.sig" ] && ! cmp -s "$out.sig" "$BETTBOX_RUN/fakeip.sig"; then
			touch "$BETTBOX_RUN/flush-fakeip"
		fi
		mv -f "$out.sig" "$BETTBOX_RUN/fakeip.sig"
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
		# The runtime file is intentionally outside the core home directory.
		# Send validated content instead of relaxing Mihomo's SAFE_PATHS guard.
		# A file body also avoids the per-argument size limit for large profiles.
		local body rc
		body=$(mktemp "$BETTBOX_RUN/reload.XXXXXX") || return 1
		if ! ucode -e 'import {readfile,writefile} from "fs"; let payload=readfile(ARGV[0]); if(payload==null || writefile(ARGV[1],sprintf("%J",{payload:payload,force:true}))==null)die("cannot prepare core reload");' "$BETTBOX_RUN/config.yaml" "$body"; then
			rm -f "$body"
			return 1
		fi
		api_call PUT '/configs?force=true' "@$body" >/dev/null
		rc=$?
		rm -f "$body"
		if [ "$rc" = 0 ] && [ -f "$BETTBOX_RUN/flush-fakeip" ]; then
			api_call POST /cache/fakeip/flush '' >/dev/null 2>&1 || true
			rm -f "$BETTBOX_RUN/flush-fakeip"
		fi
		return "$rc"
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
