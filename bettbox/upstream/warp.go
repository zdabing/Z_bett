// SPDX-License-Identifier: GPL-3.0
// Bettbox v1.19.10 (fdf5cd3), core/toolbox/warp.go.
package bettbox

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	mihomoHttp "github.com/metacubex/mihomo/component/http"
)

const (
	warpApiUrl      = "https://api.cloudflareclient.com/v0a4471/reg"
	warpDefaultHost = "engage.cloudflareclient.com"
	warpDefaultPort = 2408
	warpTimeout     = 30 * time.Second
)

var warpHeaders = map[string][]string{
	"User-Agent":        {"WARP for Android"},
	"CF-Client-Version": {"a-6.35-4471"},
	"Content-Type":      {"application/json; charset=UTF-8"},
}

type warpAccount struct {
	ID     string `json:"id"`
	Token  string `json:"token"`
	Config struct {
		ClientID string `json:"client_id"`
		Peers    []struct {
			PublicKey string `json:"public_key"`
			Endpoint  struct {
				V4    string `json:"v4"`
				Host  string `json:"host"`
				Ports []int  `json:"ports"`
			} `json:"endpoint"`
		} `json:"peers"`
		Interface struct {
			Addresses struct {
				V4 string `json:"v4"`
				V6 string `json:"v6"`
			} `json:"addresses"`
		} `json:"interface"`
	} `json:"config"`
}

type WarpResult struct {
	Proxy map[string]any `json:"proxy,omitempty"`
	ID    string         `json:"id,omitempty"`
	Token string         `json:"token,omitempty"`
	Error string         `json:"error,omitempty"`
}

type warpDoFunc func(ctx context.Context, url, method string, header map[string][]string, body []byte) (int, []byte, error)

func warpRequestMihomo(ctx context.Context, url, method string, header map[string][]string, body []byte) (int, []byte, error) {
	resp, err := mihomoHttp.HttpRequest(ctx, url, method, header, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, data, err
}

func warpRequestStd(ctx context.Context, url, method string, header map[string][]string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	for key, values := range header {
		for _, v := range values {
			req.Header.Add(key, v)
		}
	}
	client := &http.Client{Timeout: warpTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, data, err
}

func warpRequest(ctx context.Context, do warpDoFunc, method, url, token string, payload any) (*warpAccount, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	header := make(map[string][]string, len(warpHeaders)+1)
	for key, value := range warpHeaders {
		header[key] = value
	}
	if token != "" {
		header["Authorization"] = []string{"Bearer " + token}
	}
	statusCode, data, err := do(ctx, url, method, header, body)
	if err != nil {
		return nil, err
	}
	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare api: HTTP %d %s", statusCode, bytes.TrimSpace(data))
	}
	account := &warpAccount{}
	if err := json.Unmarshal(data, account); err != nil {
		return nil, err
	}
	return account, nil
}

func createWarpDevice(ctx context.Context, do warpDoFunc) (*warpAccount, *ecdh.PrivateKey, error) {
	privateKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial := make([]byte, 8)
	if _, err := rand.Read(serial); err != nil {
		return nil, nil, err
	}
	account, err := warpRequest(ctx, do, http.MethodPost, warpApiUrl, "", map[string]string{
		"key":           base64.StdEncoding.EncodeToString(privateKey.PublicKey().Bytes()),
		"install_id":    "",
		"fcm_token":     "",
		"tos":           time.Now().Format("2006-01-02T15:04:05.000-07:00"),
		"model":         "PC",
		"serial_number": hex.EncodeToString(serial),
		"os_version":    "",
		"key_type":      "curve25519",
		"tunnel_type":   "wireguard",
		"locale":        "en_US",
	})
	if err != nil {
		return nil, nil, err
	}
	if account.ID == "" || account.Token == "" {
		return nil, nil, errors.New("cloudflare api: incomplete registration")
	}
	return account, privateKey, nil
}

func registerWarpWith(ctx context.Context, do warpDoFunc) (*WarpResult, error) {
	account, privateKey, err := createWarpDevice(ctx, do)
	if err != nil {
		return nil, err
	}
	if len(account.Config.Peers) == 0 {
		return nil, errors.New("cloudflare api: missing endpoint")
	}
	peer := account.Config.Peers[0]
	server, port := warpEndpoint(peer.Endpoint.V4, peer.Endpoint.Host, peer.Endpoint.Ports)
	addresses := account.Config.Interface.Addresses
	proxy, err := warpProxy(
		privateKey.Bytes(),
		peer.PublicKey,
		account.Config.ClientID,
		server,
		port,
		addresses.V4,
		addresses.V6,
	)
	if err != nil {
		return nil, err
	}
	return &WarpResult{Proxy: proxy, ID: account.ID, Token: account.Token}, nil
}

func warpEndpoint(v4, host string, ports []int) (string, int) {
	server := ""
	if ip := warpSplitHost(v4); ip != "" {
		if addr, err := netip.ParseAddr(ip); err == nil {
			server = addr.String()
		}
	}
	hostName, hostPort := warpSplitHostPort(host)
	if server == "" {
		server = hostName
	}
	if server == "" {
		server = warpDefaultHost
	}
	port := hostPort
	if port <= 0 && len(ports) > 0 && ports[0] > 0 {
		port = ports[0]
	}
	if port <= 0 {
		port = warpDefaultPort
	}
	return server, port
}

func warpSplitHost(value string) string {
	host, _ := warpSplitHostPort(value)
	return host
}

func warpSplitHostPort(value string) (string, int) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", 0
	}
	host, portText, err := net.SplitHostPort(trimmed)
	if err != nil {
		return trimmed, 0
	}
	port, _ := strconv.Atoi(portText)
	return host, port
}

func warpReserved(clientID string) []int {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(clientID))
	if err != nil || len(raw) != 3 {
		return nil
	}
	return []int{int(raw[0]), int(raw[1]), int(raw[2])}
}

func warpProxy(privateKey []byte, peerPublicKey, clientID, server string, port int, v4, v6 string) (map[string]any, error) {
	if len(privateKey) != 32 {
		return nil, errors.New("cloudflare api: invalid private key")
	}
	peerKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(peerPublicKey))
	if err != nil || len(peerKey) != 32 {
		return nil, errors.New("cloudflare api: invalid peer public key")
	}
	if v4 == "" && v6 == "" {
		return nil, errors.New("cloudflare api: missing interface address")
	}
	if server == "" {
		server = warpDefaultHost
	}
	if port <= 0 {
		port = warpDefaultPort
	}
	proxy := map[string]any{
		"name":               "Cloudflare WARP",
		"type":               "wireguard",
		"server":             server,
		"port":               port,
		"private-key":        base64.StdEncoding.EncodeToString(privateKey),
		"public-key":         base64.StdEncoding.EncodeToString(peerKey),
		"mtu":                1280,
		"udp":                true,
		"remote-dns-resolve": true,
		"dns":                []string{"1.1.1.1", "1.0.0.1"},
	}
	if reserved := warpReserved(clientID); reserved != nil {
		proxy["reserved"] = reserved
	}
	if v4 != "" {
		proxy["ip"] = v4
	}
	if v6 != "" {
		proxy["ipv6"] = v6
	}
	return proxy, nil
}

// RegisterWarp registers a fresh Cloudflare WARP WireGuard account through Mihomo's HTTP stack.
func RegisterWarp(ctx context.Context) WarpResult {
	ctx, cancel := context.WithTimeout(ctx, warpTimeout)
	defer cancel()
	result, err := registerWarpWith(ctx, warpRequestMihomo)
	if err != nil {
		return WarpResult{Error: err.Error()}
	}
	return *result
}

// RegisterWarpCLI registers a fresh Cloudflare WARP account via standard net/http for standalone CLI mode.
func RegisterWarpCLI() WarpResult {
	ctx, cancel := context.WithTimeout(context.Background(), warpTimeout)
	defer cancel()
	result, err := registerWarpWith(ctx, warpRequestStd)
	if err != nil {
		return WarpResult{Error: err.Error()}
	}
	return *result
}
