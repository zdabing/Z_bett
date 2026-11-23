// SPDX-License-Identifier: GPL-3.0
// Bettbox v1.19.10 (fdf5cd3), core/nodes.go.
package bettbox

import (
	"encoding/json"
	"errors"
	"maps"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/dlclark/regexp2"
	"github.com/metacubex/mihomo/adapter"
	"github.com/metacubex/mihomo/common/convert"
	"github.com/metacubex/mihomo/common/utils"
	"github.com/metacubex/mihomo/common/yaml"
	yamlv3 "go.yaml.in/yaml/v3"
)

type PatchNode struct {
	Proxy   map[string]any `json:"proxy"`
	Dialer  string         `json:"dialer"`
	Groups  []string       `json:"groups"`
	Beside  string         `json:"beside"`
	Regions bool           `json:"regions"`
	Landing bool           `json:"landing"`
}

type ParseNodesResult struct {
	Proxies []map[string]any `json:"proxies"`
	Invalid int              `json:"invalid"`
	Error   string           `json:"error,omitempty"`
}

const (
	regionMarker      = "x-region"
	regionNodesMarker = "x-region-nodes"
)

var nodeProtectedProxyNames = []string{"DIRECT", "REJECT", "REJECT-DROP", "COMPATIBLE", "PASS"}

// ParseNodesFile reads and validates YAML or share-link proxies from disk.
func ParseNodesFile(path string) (ParseNodesResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ParseNodesResult{}, err
	}
	return ParseNodes(string(data)), nil
}

// ParseNodes parses YAML mappings or V2Ray/Clash share links and validates each proxy via adapter.ParseProxy.
func ParseNodes(text string) ParseNodesResult {
	result := ParseNodesResult{}
	proxies, invalid, err := parseNodesInternal(text)
	result.Proxies = proxies
	result.Invalid = invalid
	if err != nil {
		result.Error = err.Error()
	}
	return result
}

func nodeMappings(value any) []map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		if proxies, ok := typed["proxies"]; ok {
			return nodeMappings(proxies)
		}
		if _, ok := typed["type"]; ok {
			return []map[string]any{typed}
		}
	case []any:
		mappings := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if mapping, ok := item.(map[string]any); ok {
				mappings = append(mappings, mapping)
			}
		}
		return mappings
	}
	return nil
}

func parseNodesInternal(text string) ([]map[string]any, int, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, 0, errors.New("empty content")
	}
	var mappings []map[string]any
	var decoded any
	if err := yaml.Unmarshal([]byte(text), &decoded); err == nil {
		mappings = nodeMappings(decoded)
	}
	if len(mappings) == 0 {
		converted, err := convert.ConvertsV2Ray([]byte(text))
		if err != nil {
			return nil, 0, err
		}
		mappings = converted
	}
	valid := make([]map[string]any, 0, len(mappings))
	var lastErr error
	for _, mapping := range mappings {
		name, _ := mapping["name"].(string)
		if strings.TrimSpace(name) == "" {
			lastErr = errors.New("missing name")
			continue
		}
		delete(mapping, "dialer-proxy")
		proxy, err := adapter.ParseProxy(mapping)
		if err != nil {
			lastErr = err
			continue
		}
		_ = proxy.Close()
		normalized, err := plainYamlValue(mapping)
		if err == nil {
			if normMap, ok := normalized.(map[string]any); ok {
				mapping = normMap
			}
		}
		valid = append(valid, mapping)
	}
	if len(valid) == 0 {
		if lastErr == nil {
			lastErr = errors.New("no proxies found")
		}
		return nil, len(mappings), lastErr
	}
	return valid, len(mappings) - len(valid), nil
}

// PatchNodesFile injects library/landing nodes into a rendered YAML config without losing unrelated sections.
func PatchNodesFile(configPath, nodesPath, outPath string) error {
	nodesData, err := os.ReadFile(nodesPath)
	if err != nil {
		return err
	}
	var nodes []PatchNode
	if err := json.Unmarshal(nodesData, &nodes); err != nil {
		return err
	}
	cfgBytes, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	var topOrder []string
	var doc yamlv3.Node
	if err := yamlv3.Unmarshal(cfgBytes, &doc); err == nil && len(doc.Content) > 0 {
		root := doc.Content[0]
		if root.Kind == yamlv3.MappingNode {
			for i := 0; i+1 < len(root.Content); i += 2 {
				topOrder = append(topOrder, root.Content[i].Value)
			}
		}
	}
	var cfg map[string]any
	if err := yaml.Unmarshal(cfgBytes, &cfg); err != nil || cfg == nil {
		return errors.New("invalid config yaml")
	}

	proxies := mapItems(cfg["proxies"])
	groups := mapItems(cfg["proxy-groups"])
	proxies = patchNodesSlices(proxies, groups, nodes)

	outProxies := make([]any, 0, len(proxies))
	for _, p := range proxies {
		outProxies = append(outProxies, p)
	}
	cfg["proxies"] = outProxies

	outGroups := make([]any, 0, len(groups))
	for _, g := range groups {
		outGroups = append(outGroups, g)
	}
	cfg["proxy-groups"] = outGroups

	outBytes, err := marshalYamlNode(orderedYamlNode(cfg, topOrder))
	if err != nil {
		return err
	}
	return os.WriteFile(outPath, outBytes, 0600)
}

func nodeGroupName(group map[string]any) (string, bool) {
	name, ok := group["name"].(string)
	return name, ok && name != ""
}

func nodeIncludesAllProxies(group map[string]any) bool {
	if value, ok := group["include-all"].(bool); ok && value {
		return true
	}
	value, ok := group["include-all-proxies"].(bool)
	return ok && value
}

func nodeCombineExcludeFilter(target map[string]any, filter string) {
	if existing, ok := target["exclude-filter"].(string); ok && existing != "" {
		target["exclude-filter"] = existing + "|" + filter
		return
	}
	target["exclude-filter"] = filter
}

func uniqueLibraryNodeName(name string, used map[string]bool) string {
	candidate := name
	for index := 2; used[candidate]; index++ {
		candidate = name + " " + strconv.Itoa(index)
	}
	used[candidate] = true
	return candidate
}

func stripGroupRegionMarkers(groups []map[string]any) {
	for _, group := range groups {
		delete(group, regionMarker)
		delete(group, regionNodesMarker)
	}
}

func nodeGroupMembers(group map[string]any) []string {
	items, _ := group["proxies"].([]any)
	members := make([]string, 0, len(items))
	for _, item := range items {
		if name, ok := item.(string); ok {
			members = append(members, name)
		}
	}
	return members
}

func dialerReach(dialer string, groups map[string]map[string]any, dialers map[string]string) map[string]bool {
	reached := map[string]bool{}
	queue := []string{dialer}
	visit := func(name string) {
		if name != "" && !reached[name] {
			reached[name] = true
			queue = append(queue, name)
		}
	}
	reached[dialer] = true
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		group, isGroup := groups[name]
		if !isGroup {
			visit(dialers[name])
			continue
		}
		for _, member := range nodeGroupMembers(group) {
			visit(member)
		}
		if nodeIncludesAllProxies(group) {
			for _, target := range dialers {
				visit(target)
			}
		}
	}
	return reached
}

func groupHasMember(group map[string]any, names ...string) bool {
	for _, member := range nodeGroupMembers(group) {
		for _, name := range names {
			if member == name {
				return true
			}
		}
	}
	return false
}

func leadingMembersEnd(members []any, groups map[string]map[string]any, isNode map[string]bool) int {
	for index, member := range members {
		name, _ := member.(string)
		if _, ok := groups[name]; !ok && !isNode[name] && !slices.Contains(nodeProtectedProxyNames, name) {
			return index
		}
	}
	return len(members)
}

func matchesGroupFilter(group map[string]any, name string) bool {
	filter, _ := group["filter"].(string)
	if filter == "" {
		return true
	}
	for _, part := range strings.Split(filter, "`") {
		reg, err := utils.CompileRegexp(part, regexp2.None)
		if err != nil {
			continue
		}
		if ok, _ := reg.MatchString(name); ok {
			return true
		}
	}
	return false
}

func isSelectGroup(group map[string]any) bool {
	kind, _ := group["type"].(string)
	return strings.EqualFold(kind, "select")
}

func patchNodesSlices(proxies []map[string]any, groupList []map[string]any, nodes []PatchNode) []map[string]any {
	defer stripGroupRegionMarkers(groupList)
	if len(nodes) == 0 {
		return proxies
	}
	used := make(map[string]bool, len(proxies)+len(groupList)+len(nodeProtectedProxyNames)+len(nodes))
	for _, name := range nodeProtectedProxyNames {
		used[name] = true
	}
	used["GLOBAL"] = true
	dialers := map[string]string{}
	proxyNames := make(map[string]bool, len(proxies)+len(nodes))
	for _, proxy := range proxies {
		name, ok := proxy["name"].(string)
		if !ok {
			continue
		}
		used[name] = true
		proxyNames[name] = true
		if dialer, ok := proxy["dialer-proxy"].(string); ok && dialer != "" {
			dialers[name] = dialer
		}
	}
	groups := make(map[string]map[string]any, len(groupList))
	regionOf := map[string]string{}
	regionGroups := map[string][]string{}
	nodeRegions := map[string][]string{}
	for _, group := range groupList {
		name, ok := nodeGroupName(group)
		if !ok {
			continue
		}
		used[name] = true
		groups[name] = group
		region, _ := group[regionMarker].(string)
		if region == "" {
			continue
		}
		regionOf[name] = region
		regionGroups[region] = append(regionGroups[region], name)
		if !isSelectGroup(group) {
			continue
		}
		members, _ := group[regionNodesMarker].([]any)
		for _, member := range members {
			if node, ok := member.(string); ok {
				nodeRegions[node] = append(nodeRegions[node], name)
			}
		}
	}
	names := make([]string, len(nodes))
	renamed := make(map[string]string, len(nodes))
	for index, node := range nodes {
		name, _ := node.Proxy["name"].(string)
		if name == "" {
			continue
		}
		names[index] = uniqueLibraryNodeName(name, used)
		if _, ok := renamed[name]; !ok {
			renamed[name] = names[index]
		}
	}
	isNode := make(map[string]bool, len(nodes))
	for _, name := range names {
		if name != "" {
			isNode[name] = true
		}
	}
	for index, node := range nodes {
		name := names[index]
		if name == "" {
			continue
		}
		original, _ := node.Proxy["name"].(string)
		proxy := maps.Clone(node.Proxy)
		proxy["name"] = name
		delete(proxy, "dialer-proxy")
		dialer := ""
		if node.Dialer != "" {
			_, isGroup := groups[node.Dialer]
			switch {
			case isGroup || proxyNames[node.Dialer]:
				dialer = node.Dialer
			case isNode[renamed[node.Dialer]]:
				dialer = renamed[node.Dialer]
			}
		}
		var blocked map[string]bool
		if dialer != "" {
			blocked = dialerReach(dialer, groups, dialers)
			if blocked[name] {
				dialer = ""
				blocked = nil
			}
		}
		if dialer != "" {
			proxy["dialer-proxy"] = dialer
			dialers[name] = dialer
		}
		targets := map[string]bool{}
		for _, target := range node.Groups {
			if _, ok := groups[target]; ok && !blocked[target] {
				targets[target] = true
			}
		}
		if node.Beside != "" {
			for current, candidate := range groups {
				if blocked[current] || !isSelectGroup(candidate) {
					continue
				}
				if groupHasMember(candidate, node.Beside) && !groupHasMember(candidate, "REJECT", "REJECT-DROP") {
					targets[current] = true
				}
			}
		}
		if node.Regions {
			for _, current := range nodeRegions[original] {
				if !blocked[current] {
					targets[current] = true
				}
			}
		}
		if !node.Landing {
			for current := range targets {
				region := regionOf[current]
				if region == "" || !isSelectGroup(groups[current]) {
					continue
				}
				for _, peer := range regionGroups[region] {
					if !blocked[peer] {
						targets[peer] = true
					}
				}
			}
		}
		exclude := "^" + regexp.QuoteMeta(name) + "$"
		for _, group := range groupList {
			current, ok := nodeGroupName(group)
			if !ok {
				continue
			}
			includeAll := nodeIncludesAllProxies(group)
			switch {
			case targets[current] && !includeAll:
				members, _ := group["proxies"].([]any)
				pos := len(members)
				if isSelectGroup(group) {
					pos = leadingMembersEnd(members, groups, isNode)
				}
				group["proxies"] = slices.Insert(members, pos, any(name))
			case targets[current] && isSelectGroup(group) && matchesGroupFilter(group, name):
				members, _ := group["proxies"].([]any)
				group["proxies"] = slices.Insert(members, leadingMembersEnd(members, groups, isNode), any(name))
			case !targets[current] && includeAll:
				nodeCombineExcludeFilter(group, exclude)
			}
		}
		proxyNames[name] = true
		proxies = append(proxies, proxy)
	}
	return proxies
}
