#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Remove retired host-app options from existing installations. Rendering also
# enforces router policy, so legacy settings cannot re-enable these features.

[ -f /etc/config/bettbox ] || exit 0

changed=0
for key in bettbox.config.find_process_mode bettbox.config.geodata_mode \
	bettbox.config.geox_geoip bettbox.quic.exclude_china bettbox.ntp \
	bettbox.dns.override bettbox.dns.ipv6 bettbox.dns.enhanced_mode bettbox.dns.fake_ip_range \
	bettbox.dns.respect_rules bettbox.dns.nameserver bettbox.dns.default_nameserver \
	bettbox.dns.fallback bettbox.dns.proxy_server_nameserver; do
	if uci -q get "$key" >/dev/null; then
		uci -q delete "$key" || exit 1
		changed=1
	fi
done

if [ "$changed" = 1 ]; then
	uci commit bettbox
fi
