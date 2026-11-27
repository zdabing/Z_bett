#
# SPDX-License-Identifier: GPL-3.0
#
# This is free software, licensed under the GNU General Public License v3.

include $(TOPDIR)/rules.mk

PKG_NAME:=bettbox
PKG_VERSION:=1.19.34
PKG_RELEASE:=17
BETTBOX_UPSTREAM_VERSION:=1.20.0

PKG_MAINTAINER:=Bettbox for OpenWrt contributors
PKG_LICENSE:=GPL-3.0

# Build Mihomo from appshubcc/Bettbox's core/Clash.Meta tree so upstream
# router-oriented kernel patches (patch_ipv6, patch_idle, patch_healthcheck)
# are included alongside our local patches and embedded bettbox Go package.
# download.pl appends PKG_SOURCE to PKG_SOURCE_URL.
PKG_SOURCE:=v$(BETTBOX_UPSTREAM_VERSION).tar.gz
PKG_SOURCE_URL:=https://github.com/appshubcc/Bettbox/archive/refs/tags/
PKG_HASH:=90350d5562fdb1d0bfc03e5be55e10a12888ed5e73c568ea23ded5256115cc20
PKG_BUILD_DIR:=$(BUILD_DIR)/Bettbox-$(BETTBOX_UPSTREAM_VERSION)

PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1
PKG_BUILD_FLAGS:=no-mips16
PKG_FILE_DEPENDS:=./forge/Makefile ./forge/src ./upstream

QUICKJS_VERSION:=0.18.0
QUICKJS_FILE:=quickjs-ng-amalgam-$(QUICKJS_VERSION).zip

GO_PKG:=github.com/metacubex/mihomo
GO_PKG_BUILD_PKG:=$(GO_PKG)
GO_PKG_TAGS:=with_gvisor,no_easytier,no_tailscale,no_zerotier,no_fake_tcp
GO_PKG_LDFLAGS_X:=$(GO_PKG)/constant.Version=v$(PKG_VERSION) $(GO_PKG)/constant.BuildTime=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Download/quickjs
  URL:=https://github.com/quickjs-ng/quickjs/releases/download/v$(QUICKJS_VERSION)/
  URL_FILE:=quickjs-amalgam.zip
  FILE:=$(QUICKJS_FILE)
  HASH:=6c05066a6b62b483e2ba0f83d7a16688c6958182b214bfd693529434cef84a9e
endef
$(eval $(call Download,quickjs))

# Preserve Go's configure hook and explicitly compose both compile helpers.
define Build/Prepare
	$(PKG_UNPACK)
	rm -rf $(PKG_BUILD_DIR).core
	mv $(PKG_BUILD_DIR)/core/Clash.Meta $(PKG_BUILD_DIR).core
	rm -rf $(PKG_BUILD_DIR)
	mv $(PKG_BUILD_DIR).core $(PKG_BUILD_DIR)
	$(Build/Patch)
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/bettbox
	$(CP) ./upstream/*.go $(PKG_BUILD_DIR)/bettbox/
	$(CP) ./upstream/route.go.install $(PKG_BUILD_DIR)/hub/route/bettbox.go
	$(INSTALL_DIR) $(PKG_BUILD_DIR)/.bettbox-forge $(PKG_BUILD_DIR)/.bettbox-forge/vendor
	$(CP) ./forge/Makefile ./forge/src $(PKG_BUILD_DIR)/.bettbox-forge/
	unzip -q -o $(DL_DIR)/$(QUICKJS_FILE) -d $(PKG_BUILD_DIR)/.bettbox-forge/vendor
endef

define Build/Compile
	$(call GoPackage/Build/Compile)
	$(MAKE) -C $(PKG_BUILD_DIR)/.bettbox-forge \
		CC="$(TARGET_CC)" \
		CFLAGS="$(TARGET_CFLAGS) $(TARGET_CPPFLAGS)" \
		LDFLAGS="$(TARGET_LDFLAGS)" \
		VERSION="$(BETTBOX_UPSTREAM_VERSION)" \
		OUT="$(PKG_BUILD_DIR)/.bettbox-forge/bettbox-forge"
endef

define Package/bettbox
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Bettbox core (mihomo engine) for OpenWrt
  URL:=https://github.com/appshubcc/Bettbox
  DEPENDS:=$(GO_ARCH_DEPENDS) @(aarch64||x86_64) \
	+ca-bundle \
	+curl \
	+gzip \
	+coreutils-sha256sum \
	+yq \
	+ucode \
	+firewall4 \
	+ip-full \
	+kmod-tun \
	+kmod-nft-tproxy \
	+kmod-nft-socket \
	+unzip
  # A versioned provide satisfies old LuCI/world dependencies and excludes
  # simultaneous ownership by the former standalone bettbox-forge package.
  PROVIDES:=mihomo clash-meta bettbox-forge
  CONFFILES:=/etc/config/bettbox
endef

define Package/bettbox/description
  Bettbox feature set for OpenWrt: mihomo engine with procd service, nftables
  transparent proxy (TPROXY/REDIR/TUN), subscription management, Bettbox-style
  config patching (UCI -> rendered YAML, QUIC block, disabled groups,
  loopback protection) and the DNS/network toolbox.
  Includes the independent bettbox-forge QuickJS script helper.
endef

define Package/bettbox/conffiles
/etc/config/bettbox
endef

define Package/bettbox/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/mihomo $(1)/usr/bin/mihomo
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/.bettbox-forge/bettbox-forge $(1)/usr/bin/bettbox-forge
	$(INSTALL_BIN) ./files/usr/bin/bettbox $(1)/usr/bin/bettbox

	$(INSTALL_DIR) $(1)/usr/libexec/bettbox
	$(INSTALL_BIN) ./files/usr/libexec/bettbox/* $(1)/usr/libexec/bettbox/

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bettbox $(1)/etc/init.d/bettbox
	$(INSTALL_BIN) ./files/etc/init.d/bettbox-dns $(1)/etc/init.d/bettbox-dns
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./files/lib/upgrade/keep.d/bettbox $(1)/lib/upgrade/keep.d/bettbox

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
	sh /usr/libexec/bettbox/router-settings.sh || exit 1
	/etc/init.d/bettbox-dns enable || exit 1
	/etc/init.d/bettbox-dns start || exit 1
	[ "$$BETTBOX_SELF_UPDATE" != 1 ] || exit 0
	if /etc/init.d/bettbox enabled; then
		/usr/bin/bettbox apply 2>/dev/null || true
		/etc/init.d/bettbox restart 2>/dev/null || true
	fi
}
exit 0
endef

define Package/bettbox/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] || [ "$$PKG_UPGRADE" = 1 ] || [ "$$BETTBOX_SELF_UPDATE" = 1 ] || {
	/usr/libexec/bettbox/dnsmasq.sh unregister || exit 1
	/usr/libexec/bettbox/firewall.sh flush 2>/dev/null || true
}
exit 0
endef

$(eval $(call GoBinPackage,$(PKG_NAME)))
$(eval $(call BuildPackage,$(PKG_NAME)))

# Stable 25.12 SDKs lack APK_INFO. Their deferred per-package APK argument
# list accepts mkpkg options as well as scripts. Append after BuildPackage,
# which initializes this list, and keep it scoped to Bettbox.
ifneq ($(CONFIG_USE_APK),)
  APK_SCRIPTS_bettbox += --info "replaces:bettbox-forge"
endif
