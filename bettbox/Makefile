#
# SPDX-License-Identifier: GPL-3.0
#
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=bettbox
PKG_VERSION:=1.19.33
PKG_RELEASE:=1

PKG_MAINTAINER:=Bettbox for OpenWrt contributors
PKG_LICENSE:=GPL-3.0

# Engine: upstream mihomo (same base as Bettbox core/Clash.Meta). Bettbox's
# private core IPC (toolbox actions, suspend, permission helpers) is replaced
# on the router by ucode/shell against mihomo's REST API.
# download.pl appends the source filename to each mirror URL, so use the
# github archive path prefix (codeload URLs cannot take an appended name).
PKG_SOURCE:=v$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://github.com/MetaCubeX/mihomo/archive/refs/tags/
PKG_HASH:=e7c596b37ff27ec487d19b1920f73e0c97a78067ea35766530ee9659ade72711
PKG_BUILD_DIR:=$(BUILD_DIR)/mihomo-$(PKG_VERSION)

PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16

GO_PKG:=github.com/metacubex/mihomo
GO_PKG_BUILD_PKG:=$(GO_PKG)
GO_PKG_TAGS:=with_gvisor
GO_PKG_LDFLAGS_X:=$(GO_PKG)/constant.Version=v$(PKG_VERSION) $(GO_PKG)/constant.BuildTime=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Package/bettbox
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Bettbox core (mihomo engine) for OpenWrt
  URL:=https://github.com/appshubcc/Bettbox
  DEPENDS:=$(GO_ARCH_DEPENDS) \
	+ca-bundle \
	+curl \
	+yq \
	+ucode \
	+firewall4 \
	+ip-full \
	+kmod-tun \
	+kmod-nft-tproxy \
	+kmod-nft-socket \
	+unzip
  PROVIDES:=mihomo clash-meta
  CONFFILES:=/etc/config/bettbox
endef

define Package/bettbox/description
  Bettbox feature set for OpenWrt: mihomo engine with procd service, nftables
  transparent proxy (TPROXY/REDIR/TUN), subscription management, Bettbox-style
  config patching (UCI -> rendered YAML, QUIC block, disabled groups,
  loopback protection) and the DNS/network toolbox.
endef

define Package/bettbox/conffiles
/etc/config/bettbox
endef

define Package/bettbox/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/mihomo $(1)/usr/bin/mihomo
	$(INSTALL_BIN) ./files/usr/bin/bettbox $(1)/usr/bin/bettbox

	$(INSTALL_DIR) $(1)/usr/libexec/bettbox
	$(INSTALL_BIN) ./files/usr/libexec/bettbox/* $(1)/usr/libexec/bettbox/

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bettbox $(1)/etc/init.d/bettbox

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bettbox $(1)/etc/config/bettbox

	$(INSTALL_DIR) $(1)/etc/bettbox
	$(INSTALL_DIR) $(1)/etc/bettbox/profiles
	$(INSTALL_DIR) $(1)/etc/bettbox/scripts
	$(INSTALL_DIR) $(1)/etc/bettbox/rules
	$(INSTALL_DIR) $(1)/etc/bettbox/geo
	$(INSTALL_DIR) $(1)/etc/bettbox/ui
	$(INSTALL_DIR) $(1)/etc/bettbox/state
endef

define Package/bettbox/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || {
	[ -f /etc/config/bettbox ] || exit 0
	if /etc/init.d/bettbox enabled; then
		/usr/bin/bettbox apply 2>/dev/null || true
		/etc/init.d/bettbox restart 2>/dev/null || true
	fi
}
exit 0
endef

$(eval $(call GoBinPackage,$(PKG_NAME)))
$(eval $(call BuildPackage,$(PKG_NAME)))
