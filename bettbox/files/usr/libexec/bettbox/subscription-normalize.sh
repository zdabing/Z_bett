#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Preserve full YAML verbatim; only share-link subscriptions enter QuickJS.
umask 077
[ "$#" = 2 ] || { echo 'usage: subscription-normalize.sh <input> <output>' >&2; exit 1; }
input=$1
output=$2
size=$(wc -c < "$input") || exit 1
[ "$size" -gt 0 ] && [ "$size" -le 4194304 ] || { echo '订阅内容为空或超过 4 MiB 上限' >&2; exit 1; }
valid_profile() {
	[ "$(yq '(.proxies | tag == "!!seq") and (.proxies | length > 0)' "$1" 2>/dev/null)" = true ]
}
if valid_profile "$input"; then
	cp "$input" "$output"
	exit $?
fi
work=$(mktemp -d "${output}.parse.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT
ucode /usr/libexec/bettbox/subscription-input.uc "$input" "$work/input.json" || exit 1
if ! timeout 15 bettbox-forge run --script /usr/libexec/bettbox/subscription-parser.js \
	--config "$work/input.json" --out "$work/profile.json" 2> "$work/error"; then
	message=$(yq -r '.error.message // ""' "$work/error" 2>/dev/null)
	if [ -n "$message" ]; then printf '%s\n' "$message" >&2; else echo '订阅解析失败或超时，请检查内容格式' >&2; fi
	exit 1
fi
yq -P -o=yaml '.' "$work/profile.json" > "$work/profile.yaml" || exit 1
valid_profile "$work/profile.yaml" || { echo '未识别到有效的节点订阅' >&2; exit 1; }
mv -f "$work/profile.yaml" "$output"
