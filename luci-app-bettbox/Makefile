#
# SPDX-License-Identifier: GPL-3.0
#
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-bettbox
PKG_VERSION:=1.19.7
PKG_RELEASE:=1

PKG_MAINTAINER:=Bettbox for OpenWrt contributors
PKG_LICENSE:=GPL-3.0
PKG_LICENSE_FILES:=../LICENSE

LUCI_TITLE:=LuCI for Bettbox (mihomo) - proxy, subscriptions, JS overrides, toolbox
LUCI_DESCRIPTION:=Bettbox feature set on OpenWrt: dashboard widgets, proxy groups, \
 subscription management, JS override scripts (Bettbox-compatible, via bettbox-forge), \
 connections, resources, DNS/network toolbox, logs and full settings.
LUCI_DEPENDS:=+luci-base +bettbox +bettbox-forge
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
