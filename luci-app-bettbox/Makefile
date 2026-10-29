#
# SPDX-License-Identifier: GPL-3.0
#
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-bettbox
PKG_VERSION:=1.19.7
PKG_RELEASE:=5

PKG_MAINTAINER:=Bettbox for OpenWrt contributors
PKG_LICENSE:=GPL-3.0

LUCI_TITLE:=LuCI for Bettbox (mihomo) - proxy, subscriptions, JS overrides, toolbox
LUCI_DESCRIPTION:=Bettbox feature set on OpenWrt: dashboard widgets, proxy groups, \
 subscription management, JS override scripts (Bettbox-compatible, via bettbox-forge), \
 connections, resources, DNS/network toolbox, logs and full settings.
LUCI_DEPENDS:=+luci-base +bettbox
LUCI_PKGARCH:=all

# The detached APK updater reloads rpcd after both packages and service settle.
define Package/luci-app-bettbox/postinst
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	[ "$$BETTBOX_SELF_UPDATE" = 1 ] || /etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
