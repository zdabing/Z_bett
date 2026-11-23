// SPDX-License-Identifier: GPL-3.0
// Bettbox v1.19.10 (fdf5cd3), core/toolbox/node_check.go.
package bettbox

import (
	"context"
	"fmt"
	"maps"
	"time"

	"github.com/metacubex/mihomo/adapter"
	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/component/proxydialer"
	"github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
)

const (
	nodeTestURL     = "http://www.msftncsi.com/ncsi.txt"
	nodeTestTimeout = 10 * time.Second
)

type NodeTestParams struct {
	Proxy  map[string]any `json:"proxy"`
	Dialer string         `json:"dialer"`
}

type NodeTestResult struct {
	Delay int    `json:"delay"`
	Error string `json:"error,omitempty"`
}

func findRuntimeProxy(name string) (constant.Proxy, bool) {
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

// TestNode tests a candidate node mapping optionally chained through an active runtime dialer proxy/group.
func TestNode(ctx context.Context, params NodeTestParams) NodeTestResult {
	if params.Proxy == nil {
		return NodeTestResult{Error: "missing proxy"}
	}
	ctx, cancel := context.WithTimeout(ctx, nodeTestTimeout)
	defer cancel()

	mapping := maps.Clone(params.Proxy)
	delete(mapping, "dialer-proxy")
	var options []adapter.ProxyOption
	if params.Dialer != "" {
		front, ok := findRuntimeProxy(params.Dialer)
		if !ok {
			return NodeTestResult{Error: fmt.Sprintf("front proxy %s not found", params.Dialer)}
		}
		mapping["dialer-proxy"] = params.Dialer
		options = append(options, adapter.WithDialerForAPI(proxydialer.New(front, true)))
	}
	proxy, err := adapter.ParseProxy(mapping, options...)
	if err != nil {
		return NodeTestResult{Error: err.Error()}
	}
	defer func() { _ = proxy.Close() }()
	expected, err := utils.NewUnsignedRanges[uint16]("200")
	if err != nil {
		return NodeTestResult{Error: err.Error()}
	}
	delay, err := proxy.URLTest(ctx, nodeTestURL, expected)
	if err != nil {
		return NodeTestResult{Delay: int(delay), Error: err.Error()}
	}
	return NodeTestResult{Delay: int(delay)}
}
