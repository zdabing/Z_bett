#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
. /usr/libexec/bettbox/common.sh
umask 077

action=$1
sid=$2
label=$3
shift 3
case "$action" in preview|create|edit|refresh) ;; *) die '无效的合并操作' ;; esac
case "$sid" in ''|*[!A-Za-z0-9_-]*) die '无效的订阅 ID' ;; esac

mkdir -p "$BETTBOX_PROFILES" "$BETTBOX_STATE" || exit 1
work=$(mktemp -d "$BETTBOX_STATE/merge.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
if [ "$action" = refresh ] || [ "$action" = edit ]; then
	lock="$BETTBOX_PROFILES/$sid.merge-lock"
	mkdir "$lock" 2>/dev/null || die '该合并订阅正在更新'
	trap 'rmdir "$lock"; rm -rf "$work"' EXIT
	current_members=$(uci_get "bettbox.$sid.merge_members")
	[ -n "$current_members" ] || die '合并订阅不存在'
	if [ "$action" = refresh ]; then
		set -f
		set -- $current_members
		set +f
	fi
fi
[ "$#" -ge 2 ] && [ "$#" -le 8 ] || die '请选择 2 至 8 份订阅'

members=''
n=0
total=0
failed=0
: > "$work/prefixes"
# Bettbox merges the outputs of the managed script, one for each member.
if [ "$sid" = new ]; then
	printf '{}\n' > "$work/managed.json"
else
	uci -q get "bettbox.$sid.managed_routing" > "$work/managed.json" || printf '{}\n' > "$work/managed.json"
fi
ucode /usr/libexec/bettbox/managed-routing.uc "$work/managed.json" "$work/managed.js" || exit 1
opts=$(uci_get "bettbox.$sid.managed_options")
for member in "$@"; do
	case "$member" in ''|*[!A-Za-z0-9_-]*) die '无效的成员订阅 ID' ;; esac
	case " $members " in *" $member "*) die '成员订阅不能重复' ;; esac
	[ "$(uci_get "bettbox.$member")" = subscription ] &&
		[ -z "$(uci_get "bettbox.$member.merge_members")" ] || die '成员必须是普通订阅'
	members="${members:+$members }$member"
	src=$(profile_file "$member")
	if [ ! -s "$src" ]; then failed=$((failed + 1)); continue; fi
	size=$(wc -c < "$src") || exit 1
	[ "$size" -le 4194304 ] || die '成员订阅超过 4 MiB'
	total=$((total + size))
	[ "$total" -le 8388608 ] || die '成员订阅合计超过 8 MiB'
	next=$((n + 1))
	if ! timeout 5 yq -o=json -I=0 '.' "$src" > "$work/input.json" ||
		! timeout 30 bettbox-forge run --script "$work/managed.js" --config "$work/input.json" \
			${opts:+--options "$opts"} --out "$work/$next.json" 2> "$work/forge.log"; then
		rm -f "$work/$next.json"
		failed=$((failed + 1))
		log "merge member $member could not be prepared"
		continue
	fi
	n=$next
	prefix=$(uci_get "bettbox.$member.merge_prefix")
	if [ -z "$prefix" ]; then
		prefix=$(uci_get "bettbox.$member.label")
		printf 'auto:%s\n' "${prefix:-$member}" >> "$work/prefixes"
	else
		printf 'custom:%s\n' "$prefix" >> "$work/prefixes"
	fi
done
[ "$n" -gt 0 ] || die '没有可以合并的成员配置'

# Merge with the packaged Bettbox code even when a standalone Mihomo is active.
report=$(timeout 15 /usr/bin/mihomo bettbox-merge "$work/result.yaml" "$work/prefixes" "$work"/[1-8].json) ||
	die '无法合并订阅'
report=$(ucode -e 'let report=json(ARGV[0]); report.failed=int(ARGV[1]); print(sprintf("%J", report));' "$report" "$failed") || exit 1

core=$(core_binary)
if ! timeout 30 "$core" -t -d "$BETTBOX_ETC" -f "$work/result.yaml" > "$work/validate.log" 2>&1; then
	# Provider URLs or credentials can appear in the core's diagnostic output.
	die '合并配置未通过 Mihomo 校验'
fi
if [ "$action" = preview ]; then
	printf '%s\n' "$report"
	exit 0
fi

if [ "$action" = create ]; then
	sid="sub$(date +%s)$$"
	[ ! -e "$(profile_file "$sid")" ] && ! uci -q get "bettbox.$sid" >/dev/null || die '无法分配订阅 ID'
fi
target=$(profile_file "$sid")
if [ -e "$target" ]; then
	if [ "$action" = refresh ] && cmp -s "$work/result.yaml" "$target"; then
		printf '%s\n' "$report"
		exit 0
	fi
	cp "$target" "$work/previous.yaml" || exit 1
fi

active=0
if [ "$(uci_get bettbox.config.profile)" = "$sid" ] && [ "$(uci_get bettbox.config.enabled)" = 1 ]; then active=1; fi
restore() {
	if [ -f "$work/previous.yaml" ]; then
		mv -f "$work/previous.yaml" "$target" || die '恢复合并订阅失败'
	else
		rm -f "$target" || die '清理合并订阅失败'
	fi
	if [ "$active" = 1 ]; then
		/usr/libexec/bettbox/apply.sh live >&2 || log '恢复旧合并订阅后，运行配置应用失败'
	fi
}

mv -f "$work/result.yaml" "$target" || exit 1
if [ "$active" = 1 ] && ! /usr/libexec/bettbox/apply.sh live > "$work/apply.log" 2>&1; then
	restore
	die '合并订阅应用失败，已恢复上一份配置'
fi
save() {
	if [ "$action" = create ]; then uci set "bettbox.$sid=subscription" || return 1; fi
	if [ "$action" != refresh ]; then
		uci set "bettbox.$sid.label=${label:-合并订阅}" &&
			uci set "bettbox.$sid.merge_members=$members" || return 1
	fi
	uci set "bettbox.$sid.last_update=$(date +%s)" && uci commit bettbox
}
if ! save; then
	uci -q revert "bettbox.$sid"
	restore
	die '无法保存合并订阅'
fi
printf '%s\n' "$report"
