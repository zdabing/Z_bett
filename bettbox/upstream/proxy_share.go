// SPDX-License-Identifier: GPL-3.0
// Bettbox v1.19.10 (fdf5cd3), core/proxy_share.go.
package bettbox

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/dlclark/regexp2"
	"github.com/metacubex/mihomo/adapter/provider"
	"github.com/metacubex/mihomo/common/convert"
	"github.com/metacubex/mihomo/common/structure"
	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/common/yaml"
	"github.com/metacubex/mihomo/component/age"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
	yamlv3 "go.yaml.in/yaml/v3"
)

type ProxyConfigResult struct {
	Yaml   string `json:"yaml"`
	Uri    string `json:"uri"`
	Dialer string `json:"dialer,omitempty"`
}

var (
	runtimeProxyMu        sync.RWMutex
	runtimeProxies        []map[string]any
	runtimeProxyProviders map[string]map[string]any
)

// SetRuntimeProxies snapshots raw proxy and proxy-provider definitions from the active config.
func SetRuntimeProxies(proxies []map[string]any, providers map[string]map[string]any) {
	clonedProxies := make([]map[string]any, 0, len(proxies))
	for _, p := range proxies {
		if p != nil {
			clonedProxies = append(clonedProxies, maps.Clone(p))
		}
	}
	var clonedProviders map[string]map[string]any
	if len(providers) > 0 {
		clonedProviders = make(map[string]map[string]any, len(providers))
		for k, v := range providers {
			if v != nil {
				clonedProviders[k] = maps.Clone(v)
			}
		}
	}
	runtimeProxyMu.Lock()
	runtimeProxies = clonedProxies
	runtimeProxyProviders = clonedProviders
	runtimeProxyMu.Unlock()
}

func snapshotRuntimeProxies() ([]map[string]any, map[string]map[string]any) {
	runtimeProxyMu.RLock()
	proxies := runtimeProxies
	providers := runtimeProxyProviders
	runtimeProxyMu.RUnlock()
	return proxies, providers
}

// GetProxyConfig returns a deterministic YAML snippet and share URI for a runtime proxy.
func GetProxyConfig(name string) (*ProxyConfigResult, error) {
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("missing proxy name")
	}
	proxies, providers := snapshotRuntimeProxies()
	mapping, err := findProxyMapping(proxies, providers, name)
	if err != nil {
		return nil, err
	}
	dialer, _ := mapping["dialer-proxy"].(string)
	delete(mapping, "dialer-proxy")
	content, err := proxyMappingYaml(mapping)
	if err != nil {
		return nil, err
	}
	return &ProxyConfigResult{
		Yaml:   content,
		Uri:    proxyShareLink(mapping),
		Dialer: dialer,
	}, nil
}

type shareProviderProxyName struct {
	Pattern *regexp2.Regexp `provider:"pattern"`
	Target  string          `provider:"target"`
}

type shareProviderOverride struct {
	TFO              *bool                   `provider:"tfo,omitempty"`
	MPTcp            *bool                   `provider:"mptcp,omitempty"`
	UDP              *bool                   `provider:"udp,omitempty"`
	UDPOverTCP       *bool                   `provider:"udp-over-tcp,omitempty"`
	Up               *string                 `provider:"up,omitempty"`
	Down             *string                 `provider:"down,omitempty"`
	DialerProxy      *string                 `provider:"dialer-proxy,omitempty"`
	SkipCertVerify   *bool                   `provider:"skip-cert-verify,omitempty"`
	NameCertVerify   *string                 `provider:"name-cert-verify,omitempty"`
	Interface        *string                 `provider:"interface-name,omitempty"`
	RoutingMark      *int                    `provider:"routing-mark,omitempty"`
	IPVersion        *string                 `provider:"ip-version,omitempty"`
	AdditionalPrefix *string                 `provider:"additional-prefix,omitempty"`
	AdditionalSuffix *string                 `provider:"additional-suffix,omitempty"`
	ProxyName        []shareProviderProxyName `provider:"proxy-name,omitempty"`
	OverrideExpr     []provider.OverrideExpr `provider:"override-expr,omitempty"`
}

type shareProviderSchema struct {
	Type          string                `provider:"type"`
	Path          string                `provider:"path,omitempty"`
	URL           string                `provider:"url,omitempty"`
	Filter        string                `provider:"filter,omitempty"`
	ExcludeFilter string                `provider:"exclude-filter,omitempty"`
	ExcludeType   string                `provider:"exclude-type,omitempty"`
	DialerProxy   string                `provider:"dialer-proxy,omitempty"`
	Payload       []map[string]any      `provider:"payload,omitempty"`
	AgeSecretKey  string                `provider:"age-secret-key,omitempty"`
	Override      shareProviderOverride `provider:"override,omitempty"`
}

func (o *shareProviderOverride) apply(mapping map[string]any) error {
	if o.TFO != nil {
		mapping["tfo"] = *o.TFO
	}
	if o.MPTcp != nil {
		mapping["mptcp"] = *o.MPTcp
	}
	if o.UDP != nil {
		mapping["udp"] = *o.UDP
	}
	if o.UDPOverTCP != nil {
		mapping["udp-over-tcp"] = *o.UDPOverTCP
	}
	if o.Up != nil {
		mapping["up"] = *o.Up
	}
	if o.Down != nil {
		mapping["down"] = *o.Down
	}
	if o.DialerProxy != nil {
		mapping["dialer-proxy"] = *o.DialerProxy
	}
	if o.SkipCertVerify != nil {
		mapping["skip-cert-verify"] = *o.SkipCertVerify
	}
	if o.NameCertVerify != nil {
		mapping["name-cert-verify"] = *o.NameCertVerify
	}
	if o.Interface != nil {
		mapping["interface-name"] = *o.Interface
	}
	if o.RoutingMark != nil {
		mapping["routing-mark"] = *o.RoutingMark
	}
	if o.IPVersion != nil {
		mapping["ip-version"] = *o.IPVersion
	}
	name, _ := mapping["name"].(string)
	for _, expr := range o.ProxyName {
		if expr.Pattern == nil {
			continue
		}
		replaced, err := expr.Pattern.Replace(name, expr.Target, 0, -1)
		if err != nil {
			return err
		}
		name = replaced
	}
	if o.AdditionalPrefix != nil {
		name = *o.AdditionalPrefix + name
	}
	if o.AdditionalSuffix != nil {
		name += *o.AdditionalSuffix
	}
	mapping["name"] = name
	for _, expr := range o.OverrideExpr {
		if err := expr.Apply(mapping); err != nil {
			return err
		}
	}
	return nil
}

func findProxyMapping(proxies []map[string]any, providers map[string]map[string]any, name string) (map[string]any, error) {
	for _, item := range proxies {
		if item["name"] == name {
			return maps.Clone(item), nil
		}
	}
	decoder := structure.NewDecoder(structure.Option{TagName: "provider", WeaklyTypedInput: true})
	for _, providerName := range proxyProviderOrder(providers, name) {
		rawProvider := providers[providerName]
		if rawProvider == nil {
			continue
		}
		schema := &shareProviderSchema{}
		if err := decoder.Decode(rawProvider, schema); err != nil {
			continue
		}
		list, err := loadShareProviderProxies(schema)
		if err != nil {
			continue
		}
		for _, item := range list {
			if item["name"] == name {
				return item, nil
			}
		}
	}
	return nil, fmt.Errorf("proxy %s not found", name)
}

func loadShareProviderProxies(schema *shareProviderSchema) ([]map[string]any, error) {
	var mappings []map[string]any
	switch schema.Type {
	case "inline":
		mappings = schema.Payload
	case "file", "http":
		var path string
		if schema.Type == "http" && schema.Path == "" {
			path = C.Path.GetPathByHash("proxies", schema.URL)
		} else {
			path = C.Path.Resolve(schema.Path)
			if !C.Path.IsSafePath(path) {
				return nil, C.Path.ErrNotSafePath(path)
			}
		}
		buf, err := os.ReadFile(path)
		if err != nil {
			if len(schema.Payload) == 0 {
				return nil, err
			}
			mappings = schema.Payload
			break
		}
		var keys []string
		if schema.AgeSecretKey != "" {
			keys = append(keys, schema.AgeSecretKey)
		}
		decrypted, err := age.DecryptBytes(buf, keys...)
		if err != nil {
			return nil, err
		}
		parsed := struct {
			Proxies []map[string]any `yaml:"proxies"`
		}{}
		if err := yaml.Unmarshal(decrypted, &parsed); err != nil || parsed.Proxies == nil {
			converted, convErr := convert.ConvertsV2Ray(decrypted)
			if convErr != nil {
				if err != nil {
					return nil, err
				}
				return nil, convErr
			}
			parsed.Proxies = converted
		}
		mappings = parsed.Proxies
	default:
		return nil, fmt.Errorf("unsupported provider type: %s", schema.Type)
	}
	return filterShareProviderProxies(mappings, schema)
}

func filterShareProviderProxies(mappings []map[string]any, schema *shareProviderSchema) ([]map[string]any, error) {
	var excludeTypes []string
	if schema.ExcludeType != "" {
		excludeTypes = strings.Split(schema.ExcludeType, "|")
	}
	var excludeFilters []*regexp2.Regexp
	if schema.ExcludeFilter != "" {
		for _, pattern := range strings.Split(schema.ExcludeFilter, "`") {
			reg, err := utils.CompileRegexp(pattern, regexp2.None)
			if err != nil {
				return nil, err
			}
			excludeFilters = append(excludeFilters, reg)
		}
	}
	var filters []*regexp2.Regexp
	for _, pattern := range strings.Split(schema.Filter, "`") {
		reg, err := utils.CompileRegexp(pattern, regexp2.None)
		if err != nil {
			return nil, err
		}
		filters = append(filters, reg)
	}
	var result []map[string]any
	seen := map[string]bool{}
	for _, filter := range filters {
	next:
		for _, mapping := range mappings {
			if len(excludeTypes) > 0 {
				kind, ok := mapping["type"].(string)
				if !ok {
					continue
				}
				for _, excludeType := range excludeTypes {
					if strings.EqualFold(kind, excludeType) {
						continue next
					}
				}
			}
			name, ok := mapping["name"].(string)
			if !ok {
				continue
			}
			for _, exclude := range excludeFilters {
				if matched, _ := exclude.MatchString(name); matched {
					continue next
				}
			}
			if schema.Filter != "" {
				if matched, _ := filter.MatchString(name); !matched {
					continue
				}
			}
			if seen[name] {
				continue
			}
			proxy := maps.Clone(mapping)
			if schema.DialerProxy != "" {
				proxy["dialer-proxy"] = schema.DialerProxy
			}
			if err := schema.Override.apply(proxy); err != nil {
				return nil, err
			}
			seen[name] = true
			result = append(result, proxy)
		}
	}
	return result, nil
}

func proxyProviderOrder(providers map[string]map[string]any, name string) []string {
	names := make([]string, 0, len(providers))
	for providerName := range providers {
		names = append(names, providerName)
	}
	sort.Strings(names)
	for providerName, p := range tunnel.Providers() {
		if !slices.Contains(names, providerName) {
			continue
		}
		for _, proxy := range p.Proxies() {
			if proxy.Name() == name {
				index := slices.Index(names, providerName)
				names = append([]string{providerName}, slices.Delete(names, index, index+1)...)
				return names
			}
		}
	}
	return names
}

var proxyLeadingKeys = []string{"name", "type", "server", "port"}

func proxyMappingYaml(mapping map[string]any) (string, error) {
	normalized, err := plainYamlValue(mapping)
	if err != nil {
		return "", err
	}
	values, _ := normalized.(map[string]any)
	keys := make([]string, 0, len(values))
	for key := range values {
		if !slices.Contains(proxyLeadingKeys, key) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	ordered := make([]string, 0, len(values))
	for _, key := range proxyLeadingKeys {
		if _, ok := values[key]; ok {
			ordered = append(ordered, key)
		}
	}
	ordered = append(ordered, keys...)
	root := &yamlv3.Node{Kind: yamlv3.MappingNode}
	for _, key := range ordered {
		var value yamlv3.Node
		if err := value.Encode(values[key]); err != nil {
			return "", err
		}
		root.Content = append(root.Content, &yamlv3.Node{Kind: yamlv3.ScalarNode, Value: key}, &value)
	}
	out, err := marshalYamlNode(root)
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

func walkYamlScalars(node *yamlv3.Node, visit func(*yamlv3.Node)) {
	if node.Kind == yamlv3.ScalarNode {
		visit(node)
	}
	for _, child := range node.Content {
		walkYamlScalars(child, visit)
	}
}

func encodeYamlNode(root *yamlv3.Node) ([]byte, error) {
	var out strings.Builder
	encoder := yamlv3.NewEncoder(&out)
	encoder.SetIndent(2)
	if err := encoder.Encode(root); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}

// marshalYamlNode preserves non-BMP runes such as flag emojis instead of escaping them as \U0001xxxx.
func marshalYamlNode(root *yamlv3.Node) ([]byte, error) {
	const privateUseStart, privateUseEnd = rune(0xE000), rune(0xF8FF)
	used := map[rune]bool{}
	placeholders := map[rune]rune{}
	walkYamlScalars(root, func(node *yamlv3.Node) {
		for _, char := range node.Value {
			if char >= privateUseStart && char <= privateUseEnd {
				used[char] = true
			} else if char > 0xFFFF {
				placeholders[char] = 0
			}
		}
	})
	if len(placeholders) == 0 {
		return encodeYamlNode(root)
	}
	next := privateUseStart
	restore := make([]string, 0, len(placeholders)*2)
	for char := range placeholders {
		for used[next] {
			next++
		}
		if next > privateUseEnd {
			return encodeYamlNode(root)
		}
		placeholders[char] = next
		restore = append(restore, string(next), string(char))
		next++
	}
	walkYamlScalars(root, func(node *yamlv3.Node) {
		node.Value = strings.Map(func(char rune) rune {
			if placeholder, ok := placeholders[char]; ok {
				return placeholder
			}
			return char
		}, node.Value)
	})
	out, err := encodeYamlNode(root)
	if err != nil {
		return nil, err
	}
	return []byte(strings.NewReplacer(restore...).Replace(string(out))), nil
}

func plainYamlValue(value any) (any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result any
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return jsonNumbers(result), nil
}

func jsonNumbers(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = jsonNumbers(item)
		}
	case []any:
		for index, item := range typed {
			typed[index] = jsonNumbers(item)
		}
	case json.Number:
		if number, err := typed.Int64(); err == nil {
			return number
		}
		if number, err := typed.Float64(); err == nil {
			return number
		}
	}
	return value
}

type shareMapping map[string]any

func (m shareMapping) str(key string) string {
	switch value := m[key].(type) {
	case string:
		return value
	case nil:
		return ""
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	default:
		return fmt.Sprint(value)
	}
}

func (m shareMapping) boolean(key string) bool {
	switch value := m[key].(type) {
	case bool:
		return value
	case string:
		parsed, _ := strconv.ParseBool(value)
		return parsed
	}
	return false
}

func (m shareMapping) strings(key string) []string {
	switch value := m[key].(type) {
	case []string:
		return value
	case []any:
		result := make([]string, 0, len(value))
		for _, item := range value {
			result = append(result, fmt.Sprint(item))
		}
		return result
	case string:
		if value != "" {
			return []string{value}
		}
	}
	return nil
}

func (m shareMapping) sub(key string) shareMapping {
	switch value := m[key].(type) {
	case map[string]any:
		return value
	case shareMapping:
		return value
	}
	return shareMapping{}
}

func (m shareMapping) first(key string) string {
	if values := m.strings(key); len(values) > 0 {
		return values[0]
	}
	return ""
}

func (m shareMapping) hostPort() string {
	return joinShareHost(m.str("server"), m.str("port"))
}

func joinShareHost(server, port string) string {
	if strings.Contains(server, ":") && !strings.HasPrefix(server, "[") {
		server = "[" + server + "]"
	}
	return server + ":" + port
}

func shareFragment(name string) string {
	return (&url.URL{Fragment: name}).EscapedFragment()
}

func setQuery(query url.Values, key, value string) {
	if value != "" {
		query.Set(key, value)
	}
}

func shareURL(scheme string, user *url.Userinfo, host string, query url.Values, name string) string {
	link := url.URL{Scheme: scheme, User: user, Host: host, RawQuery: query.Encode()}
	if len(query) == 0 {
		link.RawQuery = ""
	}
	return link.String() + "#" + shareFragment(name)
}

func proxyShareLink(mapping map[string]any) string {
	m := shareMapping(mapping)
	if m.str("server") == "" {
		return ""
	}
	switch strings.ToLower(m.str("type")) {
	case "ss":
		return ssShareLink(m)
	case "ssr":
		return ssrShareLink(m)
	case "vmess":
		return vmessShareLink(m)
	case "vless":
		return vlessShareLink(m)
	case "trojan":
		return trojanShareLink(m)
	case "hysteria":
		return hysteriaShareLink(m)
	case "hysteria2":
		return hysteria2ShareLink(m)
	case "tuic":
		return tuicShareLink(m)
	case "anytls":
		return anytlsShareLink(m)
	case "socks5", "http":
		return socksShareLink(m)
	case "mieru":
		return mieruShareLink(m)
	}
	return ""
}

func ssShareLink(m shareMapping) string {
	cipher, password := m.str("cipher"), m.str("password")
	var user *url.Userinfo
	if strings.HasPrefix(cipher, "2022-") {
		user = url.UserPassword(cipher, password)
	} else {
		user = url.User(base64.RawURLEncoding.EncodeToString([]byte(cipher + ":" + password)))
	}
	query := url.Values{}
	if m.boolean("udp-over-tcp") {
		query.Set("uot", "1")
	}
	opts := m.sub("plugin-opts")
	switch m.str("plugin") {
	case "":
	case "obfs":
		plugin := "obfs-local;obfs=" + opts.str("mode")
		if host := opts.str("host"); host != "" {
			plugin += ";obfs-host=" + host
		}
		query.Set("plugin", plugin)
	case "v2ray-plugin":
		plugin := "v2ray-plugin;mode=" + opts.str("mode")
		if host := opts.str("host"); host != "" {
			plugin += ";host=" + host
		}
		if path := opts.str("path"); path != "" {
			plugin += ";path=" + path
		}
		if opts.boolean("tls") {
			plugin += ";tls"
		}
		query.Set("plugin", plugin)
	default:
		return ""
	}
	return shareURL("ss", user, m.hostPort(), query, m.str("name"))
}

func ssrShareLink(m shareMapping) string {
	encode := func(value string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(value))
	}
	body := strings.Join([]string{
		m.str("server"), m.str("port"), m.str("protocol"), m.str("cipher"), m.str("obfs"),
		encode(m.str("password")),
	}, ":")
	query := []string{"remarks=" + encode(m.str("name"))}
	if value := m.str("obfs-param"); value != "" {
		query = append(query, "obfsparam="+encode(value))
	}
	if value := m.str("protocol-param"); value != "" {
		query = append(query, "protoparam="+encode(value))
	}
	return "ssr://" + encode(body+"/?"+strings.Join(query, "&"))
}

func vmessShareLink(m shareMapping) string {
	values := map[string]any{
		"v":    "2",
		"ps":   m.str("name"),
		"add":  m.str("server"),
		"port": m.str("port"),
		"id":   m.str("uuid"),
		"aid":  m.str("alterId"),
		"scy":  m.str("cipher"),
		"net":  "tcp",
		"type": "none",
		"tls":  "",
	}
	if values["aid"] == "" {
		values["aid"] = "0"
	}
	if values["scy"] == "" {
		values["scy"] = "auto"
	}
	if m.boolean("tls") {
		values["tls"] = "tls"
		if sni := m.str("servername"); sni != "" {
			values["sni"] = sni
		}
		if alpn := m.strings("alpn"); len(alpn) > 0 {
			values["alpn"] = strings.Join(alpn, ",")
		}
		if fp := m.str("client-fingerprint"); fp != "" {
			values["fp"] = fp
		}
	}
	switch network := m.str("network"); network {
	case "", "tcp":
	case "http":
		opts := m.sub("http-opts")
		values["type"] = "http"
		values["host"] = opts.sub("headers").first("Host")
		values["path"] = opts.first("path")
	case "h2":
		opts := m.sub("h2-opts")
		values["net"] = "h2"
		values["host"] = opts.first("host")
		values["path"] = opts.str("path")
	case "ws":
		opts := m.sub("ws-opts")
		values["net"] = "ws"
		if opts.boolean("v2ray-http-upgrade") {
			values["net"] = "httpupgrade"
		}
		values["host"] = opts.sub("headers").str("Host")
		values["path"] = wsSharePath(opts)
	case "grpc":
		values["net"] = "grpc"
		values["path"] = m.sub("grpc-opts").str("grpc-service-name")
	default:
		return ""
	}
	data, err := json.Marshal(values)
	if err != nil {
		return ""
	}
	return "vmess://" + base64.StdEncoding.EncodeToString(data)
}

func wsSharePath(opts shareMapping) string {
	path := opts.str("path")
	early := opts.str("max-early-data")
	if early == "" || early == "0" || opts.str("early-data-header-name") != "Sec-WebSocket-Protocol" {
		return path
	}
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + "ed=" + early
}

func vlessShareLink(m shareMapping) string {
	query := url.Values{}
	setQuery(query, "encryption", m.str("encryption"))
	setQuery(query, "flow", m.str("flow"))
	if !applyVShareTransport(m, query) {
		return ""
	}
	if m.boolean("packet-addr") {
		query.Set("packetEncoding", "packet")
	}
	return shareURL("vless", url.User(m.str("uuid")), m.hostPort(), query, m.str("name"))
}

func applyVShareTransport(m shareMapping, query url.Values) bool {
	reality := m.sub("reality-opts")
	switch {
	case reality.str("public-key") != "":
		query.Set("security", "reality")
		query.Set("pbk", reality.str("public-key"))
		setQuery(query, "sid", reality.str("short-id"))
	case m.boolean("tls"):
		query.Set("security", "tls")
	default:
		query.Set("security", "none")
	}
	setQuery(query, "sni", m.str("servername"))
	if m.boolean("tls") {
		setQuery(query, "fp", m.str("client-fingerprint"))
		setQuery(query, "pcs", m.str("fingerprint"))
		if alpn := m.strings("alpn"); len(alpn) > 0 {
			query.Set("alpn", strings.Join(alpn, ","))
		}
		if m.boolean("skip-cert-verify") {
			query.Set("allowInsecure", "1")
		}
	}
	switch network := m.str("network"); network {
	case "", "tcp":
		query.Set("type", "tcp")
	case "http":
		opts := m.sub("http-opts")
		query.Set("type", "tcp")
		query.Set("headerType", "http")
		setQuery(query, "host", opts.sub("headers").first("Host"))
		setQuery(query, "path", opts.first("path"))
		setQuery(query, "method", opts.str("method"))
	case "h2":
		opts := m.sub("h2-opts")
		query.Set("type", "http")
		setQuery(query, "host", opts.first("host"))
		setQuery(query, "path", opts.str("path"))
	case "ws":
		opts := m.sub("ws-opts")
		query.Set("type", "ws")
		if opts.boolean("v2ray-http-upgrade") {
			query.Set("type", "httpupgrade")
		}
		setQuery(query, "host", opts.sub("headers").str("Host"))
		setQuery(query, "path", opts.str("path"))
		if early := opts.str("max-early-data"); early != "" && early != "0" {
			query.Set("ed", early)
		}
	case "grpc":
		query.Set("type", "grpc")
		setQuery(query, "serviceName", m.sub("grpc-opts").str("grpc-service-name"))
	case "xhttp":
		opts := m.sub("xhttp-opts")
		query.Set("type", "xhttp")
		setQuery(query, "host", opts.str("host"))
		setQuery(query, "path", opts.str("path"))
		setQuery(query, "mode", opts.str("mode"))
	default:
		return false
	}
	return true
}

func trojanShareLink(m shareMapping) string {
	query := url.Values{}
	setQuery(query, "sni", m.str("sni"))
	if alpn := m.strings("alpn"); len(alpn) > 0 {
		query.Set("alpn", strings.Join(alpn, ","))
	}
	setQuery(query, "fp", m.str("client-fingerprint"))
	setQuery(query, "pcs", m.str("fingerprint"))
	if m.boolean("skip-cert-verify") {
		query.Set("allowInsecure", "1")
	}
	switch network := m.str("network"); network {
	case "", "tcp":
	case "ws":
		opts := m.sub("ws-opts")
		query.Set("type", "ws")
		if opts.boolean("v2ray-http-upgrade") {
			query.Set("type", "httpupgrade")
		}
		setQuery(query, "host", opts.sub("headers").str("Host"))
		setQuery(query, "path", opts.str("path"))
	case "grpc":
		query.Set("type", "grpc")
		setQuery(query, "serviceName", m.sub("grpc-opts").str("grpc-service-name"))
	default:
		return ""
	}
	return shareURL("trojan", url.User(m.str("password")), m.hostPort(), query, m.str("name"))
}

func hysteriaShareLink(m shareMapping) string {
	query := url.Values{}
	setQuery(query, "peer", m.str("sni"))
	setQuery(query, "obfs", m.str("obfs"))
	if alpn := m.strings("alpn"); len(alpn) > 0 {
		query.Set("alpn", strings.Join(alpn, ","))
	}
	auth := m.str("auth-str")
	if auth == "" {
		auth = m.str("auth_str")
	}
	setQuery(query, "auth", auth)
	setQuery(query, "protocol", m.str("protocol"))
	setQuery(query, "upmbps", m.str("up"))
	setQuery(query, "downmbps", m.str("down"))
	if m.boolean("skip-cert-verify") {
		query.Set("insecure", "1")
	}
	return shareURL("hysteria", nil, m.hostPort(), query, m.str("name"))
}

func hysteria2ShareLink(m shareMapping) string {
	query := url.Values{}
	setQuery(query, "sni", m.str("sni"))
	setQuery(query, "obfs", m.str("obfs"))
	setQuery(query, "obfs-password", m.str("obfs-password"))
	if alpn := m.strings("alpn"); len(alpn) > 0 {
		query.Set("alpn", strings.Join(alpn, ","))
	}
	setQuery(query, "pinSHA256", m.str("fingerprint"))
	setQuery(query, "up", m.str("up"))
	setQuery(query, "down", m.str("down"))
	if m.boolean("skip-cert-verify") {
		query.Set("insecure", "1")
	}
	port := m.str("port")
	if ports := m.str("ports"); ports != "" {
		port = ports
	}
	var user *url.Userinfo
	if password := m.str("password"); password != "" {
		user = url.User(password)
	}
	return shareURL("hysteria2", user, joinShareHost(m.str("server"), port), query, m.str("name"))
}

func tuicShareLink(m shareMapping) string {
	user := url.User(m.str("token"))
	if uuid := m.str("uuid"); uuid != "" {
		user = url.UserPassword(uuid, m.str("password"))
	}
	query := url.Values{}
	setQuery(query, "congestion_control", m.str("congestion-controller"))
	if alpn := m.strings("alpn"); len(alpn) > 0 {
		query.Set("alpn", strings.Join(alpn, ","))
	}
	setQuery(query, "sni", m.str("sni"))
	if m.boolean("disable-sni") {
		query.Set("disable_sni", "1")
	}
	setQuery(query, "udp_relay_mode", m.str("udp-relay-mode"))
	return shareURL("tuic", user, m.hostPort(), query, m.str("name"))
}

func anytlsShareLink(m shareMapping) string {
	query := url.Values{}
	setQuery(query, "sni", m.str("sni"))
	setQuery(query, "hpkp", m.str("fingerprint"))
	if m.boolean("skip-cert-verify") {
		query.Set("insecure", "1")
	}
	return shareURL("anytls", url.User(m.str("password")), m.hostPort(), query, m.str("name"))
}

func socksShareLink(m shareMapping) string {
	scheme := "socks5"
	if m.str("type") == "http" {
		scheme = "http"
		if m.boolean("tls") {
			scheme = "https"
		}
	}
	var user *url.Userinfo
	username, password := m.str("username"), m.str("password")
	if username != "" || password != "" {
		credential := base64.RawStdEncoding.EncodeToString([]byte(username + ":" + password))
		if strings.Contains(credential, "/") {
			return ""
		}
		user = url.User(credential)
	}
	return shareURL(scheme, user, m.hostPort(), url.Values{}, m.str("name"))
}

func mieruShareLink(m shareMapping) string {
	port := m.str("port")
	if port == "" {
		port = m.str("port-range")
	}
	transport := m.str("transport")
	if port == "" || transport == "" {
		return ""
	}
	query := url.Values{}
	query.Set("profile", m.str("name"))
	query.Set("port", port)
	query.Set("protocol", transport)
	setQuery(query, "multiplexing", m.str("multiplexing"))
	setQuery(query, "handshake-mode", m.str("handshake-mode"))
	setQuery(query, "traffic-pattern", m.str("traffic-pattern"))
	user := url.UserPassword(m.str("username"), m.str("password"))
	return shareURL("mierus", user, m.str("server"), query, m.str("name"))
}
