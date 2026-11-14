// SPDX-License-Identifier: GPL-3.0
// Bettbox v1.19.8 (88b9597), core/toolbox/route_trace.go.
package bettbox

import (
	"context"
	"net/netip"
	"strings"
	"sync/atomic"
	"time"

	"github.com/metacubex/mihomo/component/resolver"
	"github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
)

const (
	routeTraceMaxSteps = 3000

	routeTraceErrorInvalid = "invalid"
)

type RouteTraceParams struct {
	Target  string `json:"target"`
	Network string `json:"network"`
	Port    int    `json:"port"`
}

type RouteTraceStep struct {
	Index    int    `json:"index"`
	Type     string `json:"type"`
	Payload  string `json:"payload"`
	Adapter  string `json:"adapter"`
	Matched  bool   `json:"matched"`
	Resolve  bool   `json:"resolve"`
	Skipped  string `json:"skipped,omitempty"`
	Duration int64  `json:"duration"`
}

type RouteTraceChain struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type RouteTraceResult struct {
	Target         string            `json:"target"`
	Host           string            `json:"host"`
	Network        string            `json:"network"`
	Port           int               `json:"port"`
	Mode           string            `json:"mode"`
	DnsMode        string            `json:"dns-mode"`
	HostsIPs       []string          `json:"hosts-ips"`
	ResolvedIPs    []string          `json:"resolved-ips"`
	ResolveTime    float64           `json:"resolve-time"`
	ResolveError   string            `json:"resolve-error"`
	ResolvedBy     int               `json:"resolved-by"`
	DstIP          string            `json:"dst-ip"`
	Total          int               `json:"total"`
	Checked        int               `json:"checked"`
	Truncated      bool              `json:"truncated"`
	Steps          []RouteTraceStep  `json:"steps"`
	Matched        *RouteTraceStep   `json:"matched,omitempty"`
	Chains         []RouteTraceChain `json:"chains"`
	SupportUDP     bool              `json:"support-udp"`
	MatchTime      float64           `json:"match-time"`
	Error          string            `json:"error"`
	FallbackDirect bool              `json:"fallback-direct"`
}

func parseRouteTarget(target string) (host string, ip netip.Addr, ok bool) {
	target = strings.TrimSpace(target)
	if index := strings.Index(target, "://"); index >= 0 {
		target = target[index+3:]
	}
	if index := strings.IndexAny(target, "/?#"); index >= 0 {
		target = target[:index]
	}
	if strings.HasPrefix(target, "[") {
		if end := strings.Index(target, "]"); end > 0 {
			target = target[1:end]
		}
	} else if strings.Count(target, ":") == 1 {
		target = target[:strings.Index(target, ":")]
	}
	target = strings.TrimSuffix(strings.ToLower(target), ".")
	if target == "" {
		return "", netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(target); err == nil {
		return "", addr.Unmap(), true
	}
	if strings.ContainsAny(target, " \t") {
		return "", netip.Addr{}, false
	}
	return target, netip.Addr{}, true
}

func traceChains(proxy constant.Proxy, metadata *constant.Metadata) ([]RouteTraceChain, bool) {
	chains := []RouteTraceChain{}
	supportUDP := true
	for current := proxy; current != nil; current = current.Unwrap(metadata, false) {
		chains = append(chains, RouteTraceChain{Name: current.Name(), Type: current.Type().String()})
		supportUDP = current.SupportUDP()
		if len(chains) > 16 {
			break
		}
	}
	return chains, supportUDP
}

func runRouteTrace(ctx context.Context, params RouteTraceParams) RouteTraceResult {
	result := RouteTraceResult{
		Target:     params.Target,
		Network:    strings.ToLower(params.Network),
		Port:       params.Port,
		Mode:       tunnel.Mode().String(),
		ResolvedBy: -1,
		Steps:      []RouteTraceStep{},
		Chains:     []RouteTraceChain{},
	}
	if result.Network != "udp" {
		result.Network = "tcp"
	}
	if result.Port <= 0 || result.Port > 65535 {
		result.Port = 443
	}
	host, ip, ok := parseRouteTarget(params.Target)
	if !ok {
		result.Error = routeTraceErrorInvalid
		return result
	}
	result.Host = host
	result.DnsMode, _ = dnsMode.Load().(string)

	metadata := &constant.Metadata{
		NetWork: constant.TCP,
		Type:    constant.INNER,
		DNSMode: constant.DNSNormal,
		Process: constant.MihomoName,
		InName:  "RouteTrace",
		Host:    host,
		DstIP:   ip,
		DstPort: uint16(result.Port),
	}
	if result.Network == "udp" {
		metadata.NetWork = constant.UDP
	}

	resolved := ip.IsValid()
	if host != "" {
		if node, ok := resolver.DefaultHosts.Search(host, false); ok {
			for _, addr := range node.IPs {
				result.HostsIPs = append(result.HostsIPs, addr.String())
			}
			if addr, err := node.RandIP(); err == nil {
				metadata.DstIP = addr
				resolved = true
			}
		}
	}

	current := -1
	helper := constant.RuleMatchHelper{
		ResolveIP: func() {
			if resolved || host == "" {
				return
			}
			resolved = true
			result.ResolvedBy = current
			resolveCtx, cancel := context.WithTimeout(ctx, resolver.DefaultDNSTimeout)
			defer cancel()
			start := time.Now()
			ips, err := resolver.LookupIP(resolveCtx, host)
			result.ResolveTime = float64(time.Since(start).Microseconds()) / 1000
			if err != nil {
				result.ResolveError = err.Error()
				return
			}
			for _, addr := range ips {
				result.ResolvedIPs = append(result.ResolvedIPs, addr.String())
			}
			if len(ips) > 0 {
				metadata.DstIP = ips[0]
			}
		},
		FindProcess: func() {},
	}

	var proxy constant.Proxy
	start := time.Now()
	switch tunnel.Mode() {
	case tunnel.Direct:
		proxy, _ = findProxy("DIRECT")
	case tunnel.Global:
		proxy, _ = findProxy("GLOBAL")
	default:
		rules := tunnel.Rules()
		result.Total = len(rules)
	rules:
		for index, rule := range rules {
			if ctx.Err() != nil {
				result.Error = "cancelled"
				return result
			}
			current = index
			ruleStart := time.Now()
			matched, adapterName := rule.Match(metadata, helper)
			step := RouteTraceStep{
				Index:    index,
				Type:     rule.RuleType().String(),
				Payload:  rule.Payload(),
				Adapter:  rule.Adapter(),
				Resolve:  result.ResolvedBy == index,
				Duration: time.Since(ruleStart).Microseconds(),
			}
			result.Checked++
			if matched {
				step.Adapter = adapterName
				adapter, ok := findProxy(adapterName)
				switch {
				case !ok:
					step.Skipped = "missing"
				case metadata.NetWork == constant.UDP && !adapter.SupportUDP():
					step.Skipped = "udp"
				default:
					for unwrap := adapter; unwrap != nil; unwrap = unwrap.Unwrap(metadata, false) {
						if unwrap.Type() == constant.Pass {
							step.Skipped = "pass"
							break
						}
					}
				}
				if step.Skipped == "" {
					step.Matched = true
					proxy = adapter
				}
			}
			if len(result.Steps) < routeTraceMaxSteps {
				result.Steps = append(result.Steps, step)
			} else {
				result.Truncated = true
			}
			if step.Matched {
				matchedStep := step
				result.Matched = &matchedStep
				break rules
			}
		}
		if proxy == nil {
			proxy, _ = findProxy("DIRECT")
			result.FallbackDirect = true
		}
	}
	result.MatchTime = float64(time.Since(start).Microseconds()) / 1000
	if metadata.DstIP.IsValid() {
		result.DstIP = metadata.DstIP.String()
	}
	if proxy != nil {
		result.Chains, result.SupportUDP = traceChains(proxy, metadata)
	}
	return result
}

// Trace evaluates the running Mihomo rule set without creating a connection.
func Trace(ctx context.Context, params RouteTraceParams) RouteTraceResult {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return runRouteTrace(ctx, params)
}

func findProxy(name string) (constant.Proxy, bool) {
	if proxy, ok := tunnel.Proxies()[name]; ok {
		return proxy, true
	}
	for _, provider := range tunnel.Providers() {
		for _, proxy := range provider.Proxies() {
			if proxy.Name() == name {
				return proxy, true
			}
		}
	}
	return nil, false
}

var dnsMode atomic.Value

func SetDNSMode(mode string) { dnsMode.Store(mode) }
