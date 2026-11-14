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
for member in "$@"; do
	case "$member" in ''|*[!A-Za-z0-9_-]*) die '无效的成员订阅 ID' ;; esac
	case " $members " in *" $member "*) die '成员订阅不能重复' ;; esac
	[ "$(uci_get "bettbox.$member")" = subscription ] &&
		[ -z "$(uci_get "bettbox.$member.merge_members")" ] || die '成员必须是普通订阅'
	members="${members:+$members }$member"
	src=$(profile_file "$member")
	[ -s "$src" ] || die '成员订阅没有可用配置'
	size=$(wc -c < "$src") || exit 1
	[ "$size" -le 4194304 ] || die '成员订阅超过 4 MiB'
	total=$((total + size))
	[ "$total" -le 8388608 ] || die '成员订阅合计超过 8 MiB'
	n=$((n + 1))
	timeout 5 yq -o=json -I=0 '.' "$src" > "$work/$n.json" || die '成员订阅 YAML 无效'
done
[ "$n" -ge 2 ] && [ "$n" -le 8 ] || die '请选择 2 至 8 份订阅'

report=$(timeout 10 ucode -e '
	import { readfile, writefile } from "fs";
	import { merge_profiles } from "/usr/libexec/bettbox/profile-merge.uc";
	let profiles = [];
	for (let i = 1; i < length(ARGV); i++) push(profiles, json(readfile(ARGV[i])));
	let merged = merge_profiles(profiles);
	if (writefile(ARGV[0], sprintf("%J", merged)) == null) die("无法写入合并配置");
	print(sprintf("%J", {ok: true, proxies: length(merged.proxies), groups: length(merged["proxy-groups"]), rules: length(merged.rules ?? []), group_names: map(slice(merged["proxy-groups"], 0, 12), group => group.name)}));
' "$work/result.yaml" "$work"/[1-8].json) || exit 1

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
	if [ "$action" = refresh ] && cmp -s "$work/result.yaml" "$target"; then exit 0; fi
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
